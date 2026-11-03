// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// #1796 (FR-REV-022): a lead busy elsewhere does not make every PR it owns look worked on. The card shows "X is on it"
// and the dominoes only when an agent works on the PR's branch: its own session there, a sub-agent placed there, or a
// sub-agent whose task names the ticket. A lead whose only work is sub-agents on other tickets reads "busy on #1788".

import { getDefaultStore } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTestMatrix } from "../agent-info/agent-features-fixture";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import { AgentBar, MinuteClock } from "./reviews-agent-bar";
import { cardState } from "./reviews-card-model";
import type { ReviewCheck, ReviewPr } from "./reviews-model";
import { CardContext, cardInputOf } from "./reviews-sections-model";
import type { BranchAgent, UpcomingAnswer } from "./reviews-upcoming-model";

setTestMatrix();

const Now = new Date(2026, 10, 2, 23, 31).getTime();
const Clock = MinuteClock.getInstance().nowAtom;
const PreviousNow = getDefaultStore().get(Clock);

beforeEach(() => getDefaultStore().set(Clock, Now));
afterEach(() => getDefaultStore().set(Clock, PreviousNow));

const Green: ReviewCheck[] = Array.from({ length: 7 }, (_, i) => ({ name: `Check ${i + 1}`, state: "success" }));

// #1791's PR, ready, CI 7/7, its report posted, signed by Arthur (#1779).
function readyPr(over: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number: 1794,
        ticket: 1791,
        title: "Card of a finished draft",
        url: "https://github.com/acme/app/pull/1794",
        branch: "fix/1791-x",
        base: "develop",
        headoid: "abc",
        createdat: "",
        updatedat: "",
        merge: "clean",
        ci: { state: "success", success: Green.length, failure: 0, pending: 0, checks: Green },
        report: { state: "present" },
        unpublished: 0,
        agents: [{ firstname: "Arthur", agent: "claude" }],
        ...over,
    };
}

function arthur(over: Partial<AgentStateInfo> = {}): AgentStateInfo {
    return {
        blockid: "arthur",
        agent: "claude",
        firstname: "Arthur",
        state: "working",
        since: Now - 60_000,
        version: 1,
        ...over,
    };
}

// The lead's main session idle at its prompt, one sub-agent running: wavesrv shows it working, in the background.
const BusyOnSubagents = arthur({
    background: true,
    subagents: 1,
    message: "1 sub-agent running",
    messagetext: { code: "agentState.subagent" },
});

const LeadOnBranch: BranchAgent = {
    branch: "fix/1791-x",
    worktree: "/w/1791",
    kind: "panel",
    blockid: "arthur",
    started: Now - 30 * 60_000,
};

function subagent(branch: string, description: string, state: BranchAgent["state"] = "running"): BranchAgent {
    return {
        branch,
        worktree: `/w/${branch}`,
        kind: "subagent",
        parentblockid: "arthur",
        parentfirstname: "Arthur",
        description,
        state,
        activeat: Now - 60_000,
    };
}

function ctx(info: AgentStateInfo, agents: BranchAgent[], humantesting: "yes" | "no" = "no"): CardContext {
    const upcoming: UpcomingAnswer = { dir: "/p", branches: [], agents, drafts: [], humantesting, at: Now };
    const states = { states: info != null ? { arthur: info } : {}, versions: {} } as AgentStatesData;
    return { upcoming, states, now: Now, boardText: (s) => s };
}

function card(c: CardContext, pr = readyPr()) {
    const input = cardInputOf(pr, null, c);
    return { input, card: cardState(input) };
}

describe("a lead busy elsewhere (#1796)", () => {
    it("reads a ready PR as the developer's when its lead only works on another ticket", () => {
        const { input, card: s } = card(
            ctx(BusyOnSubagents, [LeadOnBranch, subagent("fix/1788-y", "Deliver #1788 end to end")])
        );
        expect(s.kind).toBe("ready");
        expect(s.turn).toBe("ready");
        expect(s.sentence).toEqual({ key: "reviews.card.state.readyReview" });
        expect([s.works, s.motion]).toEqual([false, null]);
        expect(s.primary?.id).toBe("validate");
        expect(s.molten).toBe(true);
        const lead = input.agents.find((a) => a.blockId === "arthur");
        expect(lead.state).toBe("idle");
        expect(lead.held).toBeUndefined();
        expect(lead.elsewhere).toEqual({ ticket: 1788 });
    });

    it("says where the lead is busy on its line, without the dominoes", () => {
        const { input } = card(ctx(BusyOnSubagents, [LeadOnBranch, subagent("fix/1788-y", "Deliver #1788")]));
        const html = renderToStaticMarkup(<AgentBar facts={input.agents[0]} stacked />);
        expect(html).toMatch(/data-testid="reviews-agent-name"[^>]*>Arthur</);
        expect(html).toMatch(/data-testid="reviews-agent-state"[^>]*>busy on #1788</);
        expect(html).not.toContain("df-domino-loader");
        expect(html).not.toContain("sub-agent running");
    });

    it("takes the ticket from the sub-agent's task when its branch names none", () => {
        const { input } = card(ctx(BusyOnSubagents, [LeadOnBranch, subagent("spike-cache", "Explore #1802's cache")]));
        expect(input.agents[0].elsewhere).toEqual({ ticket: 1802 });
        const unknown = card(ctx(BusyOnSubagents, [LeadOnBranch, subagent("spike-cache", "Explore the cache")]));
        expect(unknown.input.agents[0].elsewhere).toEqual({ ticket: 0 });
        const html = renderToStaticMarkup(<AgentBar facts={unknown.input.agents[0]} stacked />);
        expect(html).toMatch(/data-testid="reviews-agent-state"[^>]*>busy elsewhere</);
    });

    it("keeps the agent at work when the lead's own session works on the branch", () => {
        const { card: s } = card(ctx(arthur(), [LeadOnBranch, subagent("fix/1788-y", "Deliver #1788")]));
        expect(s.kind).toBe("agent-working");
        expect(s.sentence).toEqual({
            key: "reviews.card.state.agentWorking",
            vars: { name: { key: "reviews.card.name", vars: { name: "Arthur" } } },
        });
        expect(s.works).toBe(true);
    });

    it("keeps the agent at work when a sub-agent of the lead runs on the PR's branch", () => {
        const { card: s } = card(ctx(BusyOnSubagents, [subagent("fix/1791-x", "Fix the review notes")]));
        expect(s.kind).toBe("agent-working");
        expect(s.works).toBe(true);
    });

    it("keeps the agent at work when the sub-agent's task names the PR's ticket", () => {
        const { input, card: s } = card(
            ctx(BusyOnSubagents, [LeadOnBranch, subagent("fix/1900-z", "Review #1791 before its merge")])
        );
        expect(input.agents[0].elsewhere).toBeUndefined();
        expect(s.kind).toBe("agent-working");
        expect(s.works).toBe(true);
    });

    it("leaves the doubt to the branch when a running sub-agent is not placed anywhere", () => {
        const two = arthur({ background: true, subagents: 2 });
        const { input, card: s } = card(ctx(two, [LeadOnBranch, subagent("fix/1788-y", "Deliver #1788")]));
        expect(input.agents[0].elsewhere).toBeUndefined();
        expect(s.kind).toBe("agent-working");
    });

    it("does not count a finished sub-agent as the lead's work elsewhere", () => {
        const { input } = card(ctx(BusyOnSubagents, [LeadOnBranch, subagent("fix/1788-y", "Deliver #1788", "done")]));
        expect(input.agents[0].elsewhere).toBeUndefined();
    });

    it("reads a ready PR with nobody on its branch as the developer's to review and merge", () => {
        const { card: s } = card(ctx(null, []));
        expect(s.kind).toBe("ready");
        expect(s.sentence).toEqual({ key: "reviews.card.state.readyReview" });
        expect([s.works, s.motion]).toEqual([false, null]);
    });

    it("keeps Ready to merge on a route through Human Testing, the lead busy elsewhere or not", () => {
        const nobody = card(ctx(null, [], "yes")).card;
        expect(nobody.kind).toBe("ready");
        expect(nobody.sentence).toEqual({ key: "reviews.card.state.ready" });
        const busy = card(ctx(BusyOnSubagents, [LeadOnBranch, subagent("fix/1788-y", "Deliver #1788")], "yes")).card;
        expect(busy.kind).toBe("ready");
        expect(busy.sentence).toEqual({ key: "reviews.card.state.ready" });
        expect(busy.works).toBe(false);
    });
});
