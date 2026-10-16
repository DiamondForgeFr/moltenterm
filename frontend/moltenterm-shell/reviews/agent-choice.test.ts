// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hiddenTabIds, visibleTabIds } from "../hidden-tabs";
import { translate } from "../i18n/i18n-core";
import { askReviewRebase } from "../review/review-client";
import { restartOutcome } from "../review/review-restart";
import { AgentChoiceModel, agentStartOf, askAgentChoice } from "./agent-choice";
import { originText, readOrigin } from "./agent-origin";
import { rebaseOutcome, ReviewPr } from "./reviews-model";
import { ReviewsModel } from "./reviews-store";

const setActiveTab = vi.fn();

vi.mock("@/app/store/global", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/store/global")>();
    const { atom } = await import("jotai");
    return {
        ...actual,
        atoms: { ...actual.atoms, workspace: atom({ oid: "ws-1" }) },
        getApi: () => ({ setActiveTab }),
    };
});

vi.mock("../review/review-client", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../review/review-client")>();
    return { ...actual, askReviewRebase: vi.fn(), openReviewTab: vi.fn(async () => ({ tabid: "review-tab" })) };
});

const en = (key: string, vars?: Record<string, any>) => translate("en", key, vars);
const fr = (key: string, vars?: Record<string, any>) => translate("fr", key, vars);

function pr(): ReviewPr {
    return {
        number: 737,
        title: "Fix x",
        url: "https://github.com/acme/app/pull/737",
        branch: "feature/733-x",
        base: "develop",
        headoid: "abc",
        createdat: "",
        updatedat: "",
        merge: "conflicts",
        ci: null,
        report: null,
        unpublished: 0,
    };
}

describe("hidden agent tabs (#758)", () => {
    it("leaves the hidden tabs out of the tab bars, in order", () => {
        const ws = { tabids: ["a", "h", "b"], meta: { "molten:hiddentabs": ["h", 3] } };
        expect(hiddenTabIds(ws)).toEqual(["h"]);
        expect(visibleTabIds(ws)).toEqual(["a", "b"]);
        expect(visibleTabIds({ tabids: ["a"] })).toEqual(["a"]);
        expect(visibleTabIds(null)).toEqual([]);
    });
});

describe("the origin line (#758)", () => {
    const at = new Date(2026, 9, 16, 11, 21).getTime();

    it("says who started the agent, when and why", () => {
        const origin = readOrigin({
            kind: "rebase",
            repo: "acme/app",
            number: 737,
            branch: "b",
            base: "develop",
            mergedpr: 736,
            mode: "together",
            at,
        });
        expect(originText(origin, en, "en-GB")).toBe(
            "Started by you at 11:21 after merging #736, to rebase #737 on develop"
        );
        expect(originText({ ...origin, mergedpr: 0 }, fr, "fr-FR")).toBe(
            "Lancé par vous à 11:21 pour rebaser #737 sur develop"
        );
        expect(originText({ ...origin, kind: "restart", round: 2 }, en, "en-GB")).toBe(
            "Started by you at 11:21 to apply review round 2's comments on #737"
        );
    });

    it("ignores what is not an origin", () => {
        expect(readOrigin(null)).toBeNull();
        expect(readOrigin({ kind: "review", number: 1, at: 1 })).toBeNull();
        expect(readOrigin({ kind: "rebase", number: "1", at: 1 })).toBeNull();
    });
});

describe("wavesrv's notifications about the agents it started (#758)", () => {
    it("are worded in both languages", () => {
        const vars = {
            name: "Bruno",
            number: "737",
            base: "develop",
            branch: "feature/733-x",
            count: "2",
            names: "a, b",
        };
        expect(en("server.notif.review.rebasedTitle", vars)).toBe("#737 rebased on develop by Bruno, ready for review");
        expect(fr("server.notif.review.rebasedTitle", vars)).toBe(
            "#737 rebasée sur develop par Bruno, prête pour la revue"
        );
        expect(en("server.notif.review.changes", vars)).toBe(
            "Bruno pushed, but its copy of feature/733-x has uncommitted files (2): a, b"
        );
        expect(fr("server.notif.review.openReview")).toBe("Ouvrir la revue");
    });
});

describe("the choice before an agent starts (#758)", () => {
    beforeEach(() => {
        vi.mocked(askReviewRebase).mockReset();
        setActiveTab.mockReset();
        globalStore.set(AgentChoiceModel.getInstance().pendingAtom, null);
    });

    it("answers the developer's choice, and cancels an older ask", async () => {
        const first = askAgentChoice({ kind: "rebase", number: 1, branch: "b", base: "develop" });
        const second = askAgentChoice({ kind: "restart", number: 2, branch: "b", base: "develop" });
        await expect(first).resolves.toBeNull();
        globalStore.get(AgentChoiceModel.getInstance().pendingAtom).answer("together");
        await expect(second).resolves.toBe("together");
        expect(globalStore.get(AgentChoiceModel.getInstance().pendingAtom)).toBeNull();
    });

    it("names the agent's tab in the interface language", () => {
        expect(agentStartOf("rebase", 737, "background")).toMatchObject({
            start: true,
            mode: "background",
            tabname: "Rebase #737",
        });
    });

    it("AC1: with no agent on the branch, asks, then starts out of sight without moving the window", async () => {
        vi.mocked(askReviewRebase)
            .mockResolvedValueOnce({ status: "offer", agentname: "Claude Code" })
            .mockResolvedValueOnce({
                status: "started",
                agentname: "Claude Code",
                tabid: "t1",
                hidden: true,
                branch: "feature/733-x",
            });
        const outcome = ReviewsModel.getInstance().askRebase("/p", pr(), "acme/app", 736);
        await vi.waitFor(() => expect(globalStore.get(AgentChoiceModel.getInstance().pendingAtom)).not.toBeNull());
        const pending = globalStore.get(AgentChoiceModel.getInstance().pendingAtom);
        expect(pending).toMatchObject({ kind: "rebase", number: 737, base: "develop", agent: "Claude Code" });
        pending.answer("background");
        expect(await outcome).toMatchObject({ kind: "asked", note: true });
        expect(vi.mocked(askReviewRebase).mock.calls[1][0]).toMatchObject({
            start: true,
            mode: "background",
            mergedpr: 736,
        });
        expect(setActiveTab).not.toHaveBeenCalled();
    });

    it("AC2: together, the window shows the agent's own tab", async () => {
        vi.mocked(askReviewRebase)
            .mockResolvedValueOnce({ status: "offer" })
            .mockResolvedValueOnce({ status: "started", tabid: "t2", hidden: false });
        const outcome = ReviewsModel.getInstance().askRebase("/p", pr(), "acme/app");
        await vi.waitFor(() => expect(globalStore.get(AgentChoiceModel.getInstance().pendingAtom)).not.toBeNull());
        globalStore.get(AgentChoiceModel.getInstance().pendingAtom).answer("together");
        await outcome;
        expect(setActiveTab).toHaveBeenCalledWith("t2");
    });

    it("cancelled, nothing starts", async () => {
        vi.mocked(askReviewRebase).mockResolvedValueOnce({ status: "offer" });
        const outcome = ReviewsModel.getInstance().askRebase("/p", pr(), "acme/app");
        await vi.waitFor(() => expect(globalStore.get(AgentChoiceModel.getInstance().pendingAtom)).not.toBeNull());
        globalStore.get(AgentChoiceModel.getInstance().pendingAtom).answer(null);
        expect(await outcome).toBeNull();
        expect(askReviewRebase).toHaveBeenCalledTimes(1);
    });

    it("says where an agent started out of sight went", () => {
        expect(
            rebaseOutcome({ status: "started", hidden: true, agentname: "Claude Code", branch: "b" }).text
        ).toContain("out of sight");
        expect(
            restartOutcome({ status: "started", hidden: true, agentname: "Claude Code", worktree: "/x/work-9" })
        ).toContain("out of sight in work-9");
    });
});
