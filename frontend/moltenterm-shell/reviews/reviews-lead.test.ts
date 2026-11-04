// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #1779, FR-REV-022 AC19: Resume with a lead agent, its three paths. A running lead gets the work at once and its tab is
// shown; one that no longer runs is offered a resume before anything starts, then a new agent the usual way if the
// developer prefers; with no lead the request is the usual one. The dialog's own buttons answer the choice.

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { wordPhrase } from "../i18n/phrase";
import { askReviewFinish } from "../review/review-client";
import { showPanel } from "../review/review-panels";
import { AgentChoiceModel } from "./agent-choice";
import { LeadResumeModel } from "./lead-resume";
import { leadRef, leadToShow } from "./reviews-lead";
import type { LeadFacts, ReviewPr } from "./reviews-model";
import { ReviewsModel } from "./reviews-store";

vi.mock("@/app/store/global", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/store/global")>();
    const { atom } = await import("jotai");
    return { ...actual, atoms: { ...actual.atoms, workspace: atom({ oid: "ws-1" }) } };
});

vi.mock("../opener-tab", () => ({ showTabFromHere: vi.fn() }));
vi.mock("../review/review-panels", () => ({ showPanel: vi.fn(async () => {}) }));
vi.mock("../review/review-client", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../review/review-client")>();
    return { ...actual, askReviewFinish: vi.fn() };
});

const Arthur: LeadFacts = { name: "Arthur", agentName: "Claude Code", source: "signature" };

function pr(): ReviewPr {
    return {
        number: 1772,
        title: "Pinned views per project",
        url: "https://github.com/acme/app/pull/1772",
        branch: "feature/1760-pinned-views",
        base: "develop",
        headoid: "abc",
        createdat: "",
        updatedat: "",
        draft: true,
        merge: "clean",
        ci: null,
        report: null,
        unpublished: 0,
    };
}

const model = () => ReviewsModel.getInstance();
const leadPending = () => globalStore.get(LeadResumeModel.getInstance().pendingAtom);
const choicePending = () => globalStore.get(AgentChoiceModel.getInstance().pendingAtom);
const requests = () => vi.mocked(askReviewFinish).mock.calls.map((c) => c[0]);

describe("Resume with a lead agent (#1779)", () => {
    beforeEach(() => {
        vi.mocked(askReviewFinish).mockReset();
        vi.mocked(showPanel).mockClear();
        globalStore.set(LeadResumeModel.getInstance().pendingAtom, null);
        globalStore.set(AgentChoiceModel.getInstance().pendingAtom, null);
    });

    it("a running lead gets the work at once: no dialog, its terminal shown, no new agent", async () => {
        vi.mocked(askReviewFinish).mockResolvedValueOnce({
            status: "sent",
            lead: true,
            firstname: "Arthur",
            blockid: "arthur-block",
            tabid: "arthur-tab",
        });
        const outcome = await model().askFinish("/p", pr(), "acme/app", true, Arthur);
        expect(outcome).toMatchObject({ kind: "asked", name: "Arthur", blockId: "arthur-block", note: true });
        expect(wordPhrase(outcome.text)).toBe(
            "Handed to Arthur, the lead agent that owns this work: the brief is in its terminal, it decides who does it."
        );
        expect(requests()).toHaveLength(1);
        expect(requests()[0]).toMatchObject({
            number: 1772,
            markready: true,
            lead: { firstname: "Arthur", agent: "Claude Code" },
        });
        expect(requests()[0]).not.toHaveProperty("start");
        expect(requests()[0]).not.toHaveProperty("resumelead");
        expect(leadPending()).toBeNull();
        expect(choicePending()).toBeNull();
        expect(showPanel).toHaveBeenCalledWith("arthur-block");
    });

    it("a busy lead has the brief queued and is shown all the same", async () => {
        vi.mocked(askReviewFinish).mockResolvedValueOnce({
            status: "queued",
            lead: true,
            firstname: "Arthur",
            blockid: "arthur-block",
        });
        const outcome = await model().askFinish("/p", pr(), "acme/app", true, Arthur);
        expect(wordPhrase(outcome.text)).toBe(
            "Arthur is busy: the brief is typed in its terminal when its prompt is idle."
        );
        expect(showPanel).toHaveBeenCalledWith("arthur-block");
    });

    it("a lead that no longer runs: asks first, then resumes its session in a tab named for the PR", async () => {
        vi.mocked(askReviewFinish)
            .mockResolvedValueOnce({
                status: "leadgone",
                lead: true,
                firstname: "Arthur",
                agentname: "Claude Code",
                leadfolder: "/p",
                leadguessed: true,
            })
            .mockResolvedValueOnce({ status: "started", lead: true, firstname: "Arthur", blockid: "new-block" });
        const outcome = model().askFinish("/p", pr(), "acme/app", true, Arthur);
        await vi.waitFor(() => expect(leadPending()).not.toBeNull());
        expect(leadPending()).toMatchObject({
            number: 1772,
            name: "Arthur",
            agent: "Claude Code",
            folder: "/p",
            guessed: true,
        });
        expect(requests()).toHaveLength(1);
        expect(showPanel).not.toHaveBeenCalled();
        leadPending().answer("resume");
        expect(await outcome).toMatchObject({ kind: "asked", name: "Arthur", blockId: "new-block" });
        expect(requests()[1]).toMatchObject({
            lead: { firstname: "Arthur", agent: "Claude Code" },
            resumelead: true,
            workspaceid: "ws-1",
            tabname: "Resume #1772",
        });
        expect(showPanel).toHaveBeenCalledWith("new-block");
    });

    it("a lead that no longer runs: New agent goes the usual way, with no lead", async () => {
        vi.mocked(askReviewFinish)
            .mockResolvedValueOnce({ status: "leadgone", lead: true, firstname: "Arthur", agentname: "Claude Code" })
            .mockResolvedValueOnce({ status: "offer", agentname: "Claude Code" })
            .mockResolvedValueOnce({ status: "started", tabid: "t1", hidden: true });
        const outcome = model().askFinish("/p", pr(), "acme/app", true, Arthur);
        await vi.waitFor(() => expect(leadPending()).not.toBeNull());
        leadPending().answer("new");
        await vi.waitFor(() => expect(choicePending()).not.toBeNull());
        expect(choicePending()).toMatchObject({ kind: "finish", number: 1772 });
        choicePending().answer("background");
        expect(await outcome).toMatchObject({ kind: "asked" });
        expect(requests()).toHaveLength(3);
        expect(requests()[1]).not.toHaveProperty("lead");
        expect(requests()[2]).toMatchObject({ start: true, mode: "background" });
        expect(requests()[2]).not.toHaveProperty("lead");
    });

    it("cancelled, a lead that no longer runs is not resumed and nothing starts", async () => {
        vi.mocked(askReviewFinish).mockResolvedValueOnce({ status: "leadgone", lead: true, firstname: "Arthur" });
        const outcome = model().askFinish("/p", pr(), "acme/app", true, Arthur);
        await vi.waitFor(() => expect(leadPending()).not.toBeNull());
        leadPending().answer(null);
        expect(await outcome).toBeNull();
        expect(requests()).toHaveLength(1);
        expect(showPanel).not.toHaveBeenCalled();
    });

    it("New agent from the menu names no lead: the usual request", async () => {
        vi.mocked(askReviewFinish).mockResolvedValueOnce({ status: "offer" });
        const outcome = model().askFinish("/p", pr(), "acme/app", true);
        await vi.waitFor(() => expect(choicePending()).not.toBeNull());
        expect(requests()[0]).not.toHaveProperty("lead");
        choicePending().answer(null);
        expect(await outcome).toBeNull();
        expect(leadPending()).toBeNull();
    });

    it("a lead whose CLI cannot resume leaves the usual offer", async () => {
        vi.mocked(askReviewFinish).mockResolvedValueOnce({ status: "offer", agentname: "Codex" });
        const outcome = model().askFinish("/p", pr(), "acme/app", true, Arthur);
        await vi.waitFor(() => expect(choicePending()).not.toBeNull());
        expect(leadPending()).toBeNull();
        choicePending().answer(null);
        expect(await outcome).toBeNull();
    });

    it("a refused send is a line on the card, the terminal is not shown", async () => {
        vi.mocked(askReviewFinish).mockResolvedValueOnce({
            status: "failed",
            lead: true,
            firstname: "Arthur",
            blockid: "arthur-block",
            reason: "nottyped",
            message: "Not delivered to Arthur",
        });
        expect(await model().askFinish("/p", pr(), "acme/app", true, Arthur)).toMatchObject({ kind: "failed" });
        expect(showPanel).not.toHaveBeenCalled();
    });

    it("one click reaches the lead once: a second ask for the same PR joins the open one", async () => {
        let answer: (r: Awaited<ReturnType<typeof askReviewFinish>>) => void;
        vi.mocked(askReviewFinish).mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
        const first = model().askFinish("/p", pr(), "acme/app", true, Arthur);
        const second = model().askFinish("/p", pr(), "acme/app", true, Arthur);
        const menu = model().askFinish("/p", pr(), "acme/app", true);
        expect(second).toBe(first);
        expect(menu).toBe(first);
        answer({ status: "sent", lead: true, firstname: "Arthur", blockid: "arthur-block" });
        expect(await first).toMatchObject({ kind: "asked", name: "Arthur" });
        expect(requests()).toHaveLength(1);
        expect(showPanel).toHaveBeenCalledTimes(1);
        // Once answered, the next click is a new ask, and another PR's ask never waits for this one.
        vi.mocked(askReviewFinish).mockResolvedValue({ status: "sent", lead: true, firstname: "Arthur", blockid: "b" });
        await model().askFinish("/p", pr(), "acme/app", true, Arthur);
        await model().askFinish("/p", { ...pr(), number: 1773 }, "acme/app", true, Arthur);
        expect(requests()).toHaveLength(3);
    });

    it("the lead's task is not done while the PR is a draft: the agent line never says nothing is left", async () => {
        vi.mocked(askReviewFinish).mockResolvedValue({
            status: "sent",
            lead: true,
            firstname: "Arthur",
            blockid: "arthur-block",
        });
        const asks = () => globalStore.get(model().rebaseAsksAtom);
        await model().askFinish("/p", pr(), "acme/app", true, Arthur);
        expect(asks()["/p#1772"]).toMatchObject({
            kind: "finish",
            name: "Arthur",
            blockId: "arthur-block",
            markReady: true,
        });
        await model().askFinish("/p", { ...pr(), number: 1774, draft: false }, "acme/app", true, Arthur);
        expect(asks()["/p#1774"]).not.toHaveProperty("markReady");
        await model().askFinish("/p", { ...pr(), number: 1775 }, "acme/app", false, Arthur);
        expect(asks()["/p#1775"]).not.toHaveProperty("markReady");
    });
});

describe("naming the lead to wavesrv (#1779)", () => {
    it("sends the first name and the CLI as signed, or the registry's terminal and CLI id", () => {
        expect(leadRef(Arthur)).toEqual({ firstname: "Arthur", agent: "Claude Code" });
        expect(
            leadRef({ name: "Arthur", agent: "claude", agentName: "Claude Code", blockId: "b", source: "subagent" })
        ).toEqual({ firstname: "Arthur", agent: "claude", blockid: "b" });
        expect(leadRef({ name: "", blockId: "b", source: "subagent" })).toEqual({ blockid: "b" });
    });

    it("shows the lead's terminal only when the work went to it or will once its prompt is up", () => {
        const lead = { lead: true, blockid: "b" };
        for (const status of ["sent", "typed", "queued", "started"]) {
            expect(leadToShow({ status, ...lead })).toBe("b");
        }
        for (const status of ["failed", "busy", "offer", "leadgone", "noagent"]) {
            expect(leadToShow({ status, ...lead })).toBe("");
        }
        expect(leadToShow({ status: "sent", blockid: "b" })).toBe("");
        expect(leadToShow({ status: "sent", lead: true })).toBe("");
        expect(leadToShow(null)).toBe("");
    });
});
