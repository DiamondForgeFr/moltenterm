// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #1955, FR-REV-022 AC21: the index of who works on what. What the window says when a launcher found someone at work
// (nothing was started), or handed the task to a lead to continue its sub-agent; Check the agents counts the former as
// busy and the latter as sent, and never shows a lead's terminal unasked.

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { wordPhrase } from "../i18n/phrase";
import { askReviewFinish } from "../review/review-client";
import { showPanel } from "../review/review-panels";
import { AgentChoiceModel } from "./agent-choice";
import { LeadResumeModel } from "./lead-resume";
import { rebaseOutcome, type LeadFacts, type RebaseResult, type ReviewPr } from "./reviews-model";
import { ReviewsModel } from "./reviews-store";
import { checkReportText } from "./reviews-task-model";

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

function pr(number = 1955): ReviewPr {
    return {
        number,
        title: "Agents check an index",
        url: `https://github.com/acme/app/pull/${number}`,
        branch: `feature/${number}-index`,
        base: "develop",
        headoid: "abc",
        createdat: "",
        updatedat: "",
        draft: false,
        merge: "conflicts",
        ci: null,
        report: null,
        unpublished: 0,
    };
}

const text = (result: RebaseResult) => wordPhrase(rebaseOutcome(result, null, "finish").text);

describe("what the window says of the index's verdicts", () => {
    it("someone works on it: nothing was started, and the lead can be waited for", () => {
        const subagent: RebaseResult = {
            status: "busy",
            reason: "subagentbusy",
            subagent: true,
            firstname: "Arthur",
            blockid: "arthur-block",
            branch: "feature/1955-index",
            agentstate: "working",
        };
        const outcome = rebaseOutcome(subagent, null, "finish");
        expect(outcome).toMatchObject({ kind: "info", busy: { blockId: "arthur-block", name: "Arthur" } });
        expect(wordPhrase(outcome.text)).toBe(
            "A sub-agent of Arthur is already working on feature/1955-index: nothing was started."
        );

        const background = rebaseOutcome(
            { status: "busy", reason: "backgroundbusy", branch: "feature/1955-index" },
            null,
            "rebase"
        );
        expect(background).toMatchObject({ kind: "info" });
        expect(background.busy).toBeUndefined();
        expect(wordPhrase(background.text)).toBe(
            "An agent is probably already working on feature/1955-index: nothing was started."
        );
    });

    it("a worktree held by an agent: refused, named, and not queued (the agent there is not working)", () => {
        const outcome = rebaseOutcome(
            {
                status: "busy",
                reason: "treeinuse",
                firstname: "Rita",
                blockid: "rita-block",
                worktree: "/work/app-9",
            },
            null,
            "investigate"
        );
        expect(outcome.kind).toBe("info");
        expect(outcome.busy).toBeUndefined();
        expect(wordPhrase(outcome.text)).toBe(
            "An agent (Rita) already works in app-9: no second agent was started there."
        );
    });

    it("the lead continues its sub-agent: sent or queued, in the sentence that says so", () => {
        expect(text({ status: "sent", lead: true, subagent: true, firstname: "Arthur" })).toBe(
            "Handed to Arthur, which continues its sub-agent that already worked on this: the brief is in its terminal."
        );
        expect(text({ status: "queued", lead: true, subagent: true, firstname: "Arthur" })).toBe(
            "Arthur is busy: the brief is typed in its terminal when its prompt is idle, and it continues its sub-agent."
        );
        expect(text({ status: "sent", lead: true, firstname: "Arthur" })).toContain(
            "the lead agent that owns this work"
        );
    });
});

describe("Check the agents with the index (#1955)", () => {
    beforeEach(() => {
        vi.mocked(askReviewFinish).mockReset();
        vi.mocked(showPanel).mockClear();
        globalStore.set(LeadResumeModel.getInstance().pendingAtom, null);
        globalStore.set(AgentChoiceModel.getInstance().pendingAtom, null);
    });

    it("a working sub-agent counts as busy, a resumed one as sent, nothing starts and no terminal opens", async () => {
        vi.mocked(askReviewFinish)
            .mockResolvedValueOnce({
                status: "busy",
                reason: "subagentbusy",
                subagent: true,
                firstname: "Arthur",
                blockid: "arthur-block",
            })
            .mockResolvedValueOnce({
                status: "sent",
                lead: true,
                subagent: true,
                firstname: "Arthur",
                blockid: "arthur-block",
                tabid: "arthur-tab",
            });
        const report = await ReviewsModel.getInstance().checkAgents("/p", "acme/app", [pr(1955), pr(1956)]);
        expect(report).toMatchObject({ checked: 2, needs: 2, sent: 1, busy: 1, started: 0, failed: 0 });
        expect(report.offers).toHaveLength(0);
        expect(vi.mocked(askReviewFinish).mock.calls.map((c) => c[0])).toHaveLength(2);
        for (const [request] of vi.mocked(askReviewFinish).mock.calls) {
            expect(request).not.toHaveProperty("start");
            expect(request).not.toHaveProperty("lead");
        }
        expect(showPanel).not.toHaveBeenCalled();
        const tCount = (key: string, count: number) => `${key}:${count}`;
        expect(checkReportText(tCount, report)).toContain("reviews.check.busy:1");
    });

    it("the card's own Resume still shows the lead it handed the work to", async () => {
        vi.mocked(askReviewFinish).mockResolvedValueOnce({
            status: "sent",
            lead: true,
            subagent: true,
            firstname: "Arthur",
            blockid: "arthur-block",
        });
        await ReviewsModel.getInstance().askFinish("/p", pr(), "acme/app", true, Arthur);
        expect(showPanel).toHaveBeenCalledWith("arthur-block");
    });
});
