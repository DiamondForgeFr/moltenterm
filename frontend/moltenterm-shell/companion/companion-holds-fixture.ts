// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Invented agents for the tests of who holds a ticket (#2418): three leads of one workspace (Flore on Claude Code,
// Jérôme on Kimi, Julie on Claude Code) with sub-agents on tickets 1 to 6 of a milestone, tickets 7 to 9 free, and one
// agent of another workspace (Rémy on Codex). Synthetic data only.

import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import type { ReviewPr, ReviewsAnswer } from "../reviews/reviews-model";
import type { BranchAgent, UpcomingAnswer, UpcomingBranch } from "../reviews/reviews-upcoming-model";
import type { LinkAgent, MilestoneInfo, MilestoneTicket } from "./companion-milestone-model";

export const ThisWorkspace = "ws1";
export const OtherWorkspace = "ws2";

export function agentState(
    blockid: string,
    agent: string,
    agentname: string,
    firstname: string,
    workspaceid = ThisWorkspace
): AgentStateInfo {
    return { blockid, workspaceid, agent, agentname, firstname, state: "working", version: 1 };
}

export const Flore = agentState("flore", "claude", "Claude Code", "Flore");
export const Jerome = agentState("jerome", "kimi", "Kimi Code", "Jérôme");
export const Julie = agentState("julie", "claude", "Claude Code", "Julie");
export const Remy = agentState("remy", "codex", "Codex", "Rémy", OtherWorkspace);

export function statesOf(...infos: AgentStateInfo[]): AgentStatesData {
    return { states: Object.fromEntries(infos.map((i) => [i.blockid, i])), versions: {} };
}

export const EveryLead = statesOf(Flore, Jerome, Julie, Remy);

// A sub-agent of a lead, on its ticket's branch in its own worktree.
export function subagent(
    lead: AgentStateInfo,
    ticket: number,
    state: BranchAgent["state"] = "running",
    more: Partial<BranchAgent> = {}
): BranchAgent {
    return {
        branch: `feature/${ticket}-work`,
        worktree: `/shop/.worktrees/agent-${ticket}`,
        kind: "subagent",
        agent: lead.agent,
        parentblockid: lead.blockid,
        parentfirstname: lead.firstname,
        description: `#${ticket} work on the ticket`,
        state,
        activeat: 1,
        ...more,
    };
}

// A lead's own panel, on a branch.
export function panelOn(lead: AgentStateInfo, branch: string, more: Partial<BranchAgent> = {}): BranchAgent {
    return {
        branch,
        worktree: `/shop/.worktrees/${lead.blockid}`,
        kind: "panel",
        blockid: lead.blockid,
        agent: lead.agent,
        firstname: lead.firstname,
        ...more,
    };
}

export function upcomingOf(agents: BranchAgent[], branches: UpcomingBranch[] = []): UpcomingAnswer {
    return { dir: "/shop", branches, agents, at: 1 };
}

export function reviewsOf(...prs: Partial<ReviewPr>[]): ReviewsAnswer {
    return {
        dir: "/shop",
        ready: [],
        drafts: prs.map((pr) => ({ title: "A PR", base: "develop", ...pr }) as ReviewPr),
    };
}

// The developer's case: lead A has sub-agents on tickets 1 to 3, lead B (Kimi) on 4 and 5, lead C on 6; 7 to 9 are free.
export const AllLeads = upcomingOf([
    panelOn(Flore, "develop"),
    panelOn(Jerome, "develop"),
    panelOn(Julie, "develop"),
    ...[1, 2, 3].map((n) => subagent(Flore, n)),
    ...[4, 5].map((n) => subagent(Jerome, n)),
    subagent(Julie, 6),
]);

export function ticketsOf(...numbers: number[]): MilestoneTicket[] {
    return numbers.map((number) => ({
        number,
        title: `Ticket ${number} title`,
        url: `https://example.test/${number}`,
    }));
}

export const NineTickets = ticketsOf(1, 2, 3, 4, 5, 6, 7, 8, 9);

export function nineOpen(): MilestoneInfo {
    return {
        number: 2,
        title: "1.0.0",
        url: "https://example.test/milestone/2",
        open: 9,
        closed: 3,
        remaining: 9,
        loaded: true,
        tickets: NineTickets,
    };
}

// The tickets of a lead's companion, linked to the agents that work on them: one agent per ticket, as the companion links
// its own sub-agents.
export function linksOf(...numbers: number[]): Map<number, LinkAgent[]> {
    return new Map(
        numbers.map((n) => [
            n,
            [
                {
                    id: `sub${n}`,
                    name: `#${n} work on the ticket`,
                    state: "running",
                    ticket: n,
                    description: "",
                } as LinkAgent,
            ],
        ])
    );
}
