// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #2297 (FR-REV-022 AC24): a sub-agent is tied to a pull request only on real evidence (its branch, its folder in the
// PR's worktree, or a task naming the PR while its lead already works on the branch), never on a "#N" in its task
// alone. A ready, green PR nobody works on is offered for merge, and its card names one lead.

import { describe, expect, it } from "vitest";
import { setTestMatrix } from "../agent-info/agent-features-fixture";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import { cardState } from "./reviews-card-model";
import type { ReviewCheck, ReviewPr } from "./reviews-model";
import { groupByLead, prOwner } from "./reviews-owners-model";
import { CardContext, cardInputOf } from "./reviews-sections-model";
import type { BranchAgent, UpcomingAnswer } from "./reviews-upcoming-model";

setTestMatrix();

const Now = new Date(2026, 10, 13, 10, 0).getTime();

const Green: ReviewCheck[] = Array.from({ length: 5 }, (_, i) => ({ name: `Check ${i + 1}`, state: "success" }));

// A synthetic project's ready PR: out of draft, CI green, no conflict, signed by Iris.
function readyPr(over: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number: 12,
        ticket: 10,
        title: "Notes no longer cut short",
        url: "https://github.com/acme/app/pull/12",
        branch: "fix/10-truncated-notes",
        base: "develop",
        headoid: "abc",
        createdat: "",
        updatedat: "",
        merge: "clean",
        ci: { state: "success", success: Green.length, failure: 0, pending: 0, checks: Green },
        report: { state: "present" },
        unpublished: 0,
        agents: [{ firstname: "Iris", agent: "claude" }],
        ...over,
    };
}

function lead(blockid: string, firstname: string, over: Partial<AgentStateInfo> = {}): AgentStateInfo {
    return {
        blockid,
        agent: "claude",
        firstname,
        state: "working",
        background: true,
        subagents: 1,
        since: Now - 60_000,
        version: 1,
        ...over,
    };
}

function subagent(parent: string, parentName: string, branch: string, description: string): BranchAgent {
    return {
        branch,
        worktree: branch ? `/w/${branch}` : "",
        kind: "subagent",
        parentblockid: parent,
        parentfirstname: parentName,
        description,
        state: "running",
        activeat: Now - 2 * 60_000,
    };
}

function ctx(infos: AgentStateInfo[], agents: BranchAgent[]): CardContext {
    const upcoming: UpcomingAnswer = { dir: "/p", branches: [], agents, drafts: [], humantesting: "no", at: Now };
    const states = { states: Object.fromEntries(infos.map((i) => [i.blockid, i])), versions: {} } as AgentStatesData;
    return { upcoming, states, now: Now, boardText: (s) => s };
}

function card(c: CardContext, pr = readyPr()) {
    const input = cardInputOf(pr, null, c);
    return { input, card: cardState(input) };
}

describe("a sub-agent tied to a PR only on evidence (#2297)", () => {
    // Acceptance 1: Bruno's sub-agents number his own tasks: one works on another branch, one in no worktree, and both
    // name #12 in their task.
    it("offers a ready green PR for merge when another lead's sub-agents only name its number", () => {
        const c = ctx(
            [lead("bruno", "Bruno")],
            [
                subagent("bruno", "Bruno", "feature/30-git-hook", "Deliver #12 git hook"),
                subagent("bruno", "Bruno", "", "Deliver #12 git hook review"),
            ]
        );
        const { input, card: s } = card(c);
        expect(input.agents).toEqual([]);
        expect(s.kind).toBe("ready");
        expect(s.turn).toBe("ready");
        expect([s.works, s.motion]).toEqual([false, null]);
        expect(s.primary?.id).toBe("validate");
        expect(s.primary?.disabled).toBeUndefined();
    });

    it("does not tie a sub-agent naming the ticket either, while its lead is not on the branch", () => {
        const { input, card: s } = card(ctx([lead("bruno", "Bruno")], [subagent("bruno", "Bruno", "", "Review #10")]));
        expect(input.agents).toEqual([]);
        expect(s.kind).toBe("ready");
    });

    // Acceptance 2.
    it("keeps the PR in progress while a sub-agent works on its own branch", () => {
        const c = ctx([lead("iris", "Iris")], [subagent("iris", "Iris", "fix/10-truncated-notes", "Fix the notes")]);
        const { input, card: s } = card(c);
        expect(input.agents.map((a) => a.kind)).toEqual(["subagent"]);
        expect(s.kind).toBe("agent-working");
        expect(s.turn).toBe("waiting");
        expect(s.works).toBe(true);
    });

    it("still ties a read-only sub-agent naming the PR when its lead already works on the branch", () => {
        const onBranch: BranchAgent = {
            branch: "fix/10-truncated-notes",
            worktree: "/w/10",
            kind: "panel",
            blockid: "iris",
            started: Now - 30 * 60_000,
        };
        const reviewer = subagent("iris", "Iris", "", "Review PR #12");
        const { input } = card(ctx([lead("iris", "Iris")], [onBranch, reviewer]));
        expect(input.agents.some((a) => a.kind === "subagent" && a.description === "Review PR #12")).toBe(true);
    });

    // Acceptance 3: the group, the "is on it" line and the sub-agent row name the same lead.
    it("names one lead on the card", () => {
        const c = ctx(
            [lead("iris", "Iris"), lead("bruno", "Bruno")],
            [
                subagent("iris", "Iris", "fix/10-truncated-notes", "Fix the notes"),
                subagent("bruno", "Bruno", "", "Deliver #12 git hook"),
            ]
        );
        const pr = readyPr();
        const { input, card: s } = card(c, pr);
        const group = groupByLead([pr], (p) => prOwner(p, c.upcoming), [])[0];
        expect(group.lead).toBe("Iris");
        expect(s.sentence).toEqual({
            key: "reviews.card.state.agentWorking",
            vars: { name: { key: "reviews.card.name", vars: { name: "Iris" } } },
        });
        expect(input.agents.map((a) => a.parentName)).toEqual(["Iris"]);
    });

    // FR-REV-032, #943: a missing test report is a muted fact, never a reason to hide the merge without Human Testing.
    it("offers the merge of a ready green PR without a test report", () => {
        const { card: s } = card(ctx([], []), readyPr({ report: { state: "missing" } }));
        expect(s.kind).toBe("ready");
        expect(s.primary?.id).toBe("validate");
        expect(s.primary?.disabled).toBeUndefined();
        expect(s.primary?.confirm).toBeUndefined();
        expect(s.facts.find((f) => f.id === "report")).toMatchObject({ tone: "muted" });
    });
});
