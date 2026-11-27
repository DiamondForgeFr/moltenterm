// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Who holds each ticket of the milestone shown (FR-SHELL-018, #2418): the Tasks block answers "what is left to do" and
// "what this agent is moving on", so a ticket another agent works on leaves this companion's list of work to do. The
// holder comes from what MoltenTerm already knows of the running agents and does not ask anything new: the Integration
// panel's placement of every agent on its branch (the upcoming work, sub-agents of every provider included), the agent
// states the windows hold, the pull requests the Reviews list holds and the board status wavesrv read with the tickets.
// Pure, so it is tested without a window.

import { AgentStatesData, agentToolName } from "../agent-state-model";
import { branchTicketNumber } from "../agent-work-model";
import { ReviewPr, ReviewsAnswer } from "../reviews/reviews-model";
import { AgentBarFacts, agentFacts, branchAgents, UpcomingAnswer } from "../reviews/reviews-upcoming-model";
import {
    certainTicket,
    LinkAgent,
    MaxMilestoneRows,
    MilestoneInfo,
    MilestoneTicket,
} from "./companion-milestone-model";

// The agent that works on a ticket another companion's agent does not: its first name and tool, and the panel to go to.
// For a sub-agent, name and blockId are its lead's: the sub-agent has no panel of its own.
export type TicketOwner = {
    blockId: string;
    name: string;
    tool: string;
    subagent: boolean;
};

export type TicketHold =
    // This companion's agent, or one of its sub-agents.
    | { kind: "mine" }
    // Another agent of this workspace.
    | { kind: "agent"; owner: TicketOwner }
    // An agent of another workspace: the ticket is taken; the tag stays the same (the activity shown stays per
    // workspace) and its tip names the agent (#2572).
    | { kind: "away"; owner?: TicketOwner }
    // No agent MoltenTerm knows, but the ticket is taken all the same:
    | { kind: "status"; status: string }
    | { kind: "pr"; pr: number; url?: string }
    | { kind: "branch"; branch: string }
    // In review on the board with an open pull request and no agent at work (#2454): it waits for the developer to
    // review and merge it, which is no idle ticket.
    | { kind: "review"; pr: number; url?: string; status: string }
    // Nobody holds it.
    | { kind: "free" };

export type HoldKind = TicketHold["kind"];

// Where a hold puts a ticket (#2454): this agent's work, another live holder's ("with others"), waiting for the
// developer's review ("to review"), taken with nobody at work on it ("in progress, nobody on it"), or free. Only a live
// agent makes a ticket another's: a board status, a pull request or a worktree branch with no agent at work on it is
// idle, except a ticket in review with its open pull request.
export type HoldGroup = "mine" | "other" | "review" | "idle" | "free";

export function holdGroup(kind: HoldKind): HoldGroup {
    switch (kind) {
        case "mine":
            return "mine";
        case "agent":
        case "away":
            return "other";
        case "review":
            return "review";
        case "status":
        case "pr":
        case "branch":
            return "idle";
    }
    return "free";
}

// A board column where the work waits for its review: "In review", "Code review"...
export function statusInReview(status: string): boolean {
    return /\breview\b/.test((status ?? "").trim().toLowerCase());
}

// The board's In progress column, which the idle group's own title already says.
export function statusInProgress(status: string): boolean {
    return (status ?? "").trim().replace(/\s+/g, " ").toLowerCase() === "in progress";
}

export type HoldInputs = {
    // The tickets this companion's agent or its sub-agents work on (ticketLinks).
    mine: Map<number, LinkAgent[]>;
    // This companion's own terminal, whose agent and sub-agents never count as another's.
    ownBlockId: string;
    workspaceId: string;
    upcoming: UpcomingAnswer;
    reviews: ReviewsAnswer;
    states: AgentStatesData;
};

// The board columns before the work starts, by their name in lower case. Any other column, In progress and every one
// after it, means somebody took the ticket. A board that names its columns otherwise reads as started, never the other
// way round: a ticket is offered less rather than twice.
const NotStartedStatuses = new Set(["", "backlog", "ready", "todo", "to do", "new", "triage", "planned", "icebox"]);

export function statusStarted(status: string): boolean {
    return !NotStartedStatuses.has((status ?? "").trim().replace(/\s+/g, " ").toLowerCase());
}

type Candidates = {
    branches: Map<number, Set<string>>;
    prs: Map<number, { number: number; url?: string }>;
    worktrees: Map<number, string>;
};

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
    if (!map.has(key)) {
        map.set(key, new Set());
    }
    map.get(key).add(value);
}

// The branches, pull requests and worktrees that name a ticket: a ticket's branch is feature|fix/<N>-…; a sub-agent still
// on its own worktree-agent-… branch is on the ticket its description starts with (the rule the sub-agents of this
// companion are linked by).
function candidatesOf(upcoming: UpcomingAnswer, reviews: ReviewsAnswer): Candidates {
    const found: Candidates = { branches: new Map(), prs: new Map(), worktrees: new Map() };
    for (const b of upcoming?.branches ?? []) {
        if (b.ticket > 0 && b.branch) {
            addTo(found.branches, b.ticket, b.branch);
            if (b.worktree) {
                found.worktrees.set(b.ticket, b.branch);
            }
        }
    }
    for (const a of upcoming?.agents ?? []) {
        const ticket = certainTicket(a.branch, a.kind === "subagent" ? a.description : "");
        if (ticket > 0 && a.branch) {
            addTo(found.branches, ticket, a.branch);
        }
    }
    for (const pr of [...(reviews?.ready ?? []), ...(reviews?.drafts ?? [])] as ReviewPr[]) {
        const ticket = pr.ticket || branchTicketNumber(pr.branch);
        if (ticket > 0) {
            found.prs.set(ticket, { number: pr.number, url: pr.url });
            if (pr.branch) {
                addTo(found.branches, ticket, pr.branch);
            }
        }
    }
    for (const p of upcoming?.prbranches ?? []) {
        if (p.ticket > 0 && !found.prs.has(p.ticket)) {
            found.prs.set(p.ticket, { number: p.pr });
        }
    }
    for (const d of upcoming?.drafts ?? []) {
        if (d.ticket > 0 && !found.prs.has(d.ticket)) {
            found.prs.set(d.ticket, { number: 0 });
        }
    }
    return found;
}

// The agents that hold a ticket: those placed on its branches, working now. A sub-agent that finished, or went quiet,
// no longer holds it; a panel that only passed through the worktree, or whose work is sub-agents on other tickets, does
// not work on it either (the Integration panel says the same of them). This companion's agent and its sub-agents are
// not owners: mine says one of them is there (#2522: a sub-agent in a worktree beside the project folder, which its
// records do not name, is placed there by the Integration panel all the same).
function ownersOf(
    ticket: number,
    branches: Set<string>,
    pr: number,
    inputs: HoldInputs
): { owners: TicketOwner[]; mine: boolean } {
    const owners: TicketOwner[] = [];
    let mine = false;
    const seen = new Set<string>();
    for (const branch of branches ?? []) {
        for (const facts of branchAgents(inputs.upcoming, inputs.states, branch, ticket, pr || undefined)) {
            if (facts.kind === "panel" && (facts.visiting || facts.elsewhere != null)) {
                continue;
            }
            if (facts.kind === "subagent" && facts.subState !== "running") {
                continue;
            }
            if (
                inputs.ownBlockId &&
                (facts.blockId === inputs.ownBlockId || facts.parentBlockId === inputs.ownBlockId)
            ) {
                mine = true;
                continue;
            }
            const owner = ownerOf(facts, inputs.states);
            if (owner == null) {
                continue;
            }
            const key = `${facts.kind}:${owner.blockId}:${facts.description ?? ""}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            owners.push(owner);
        }
    }
    return { owners, mine };
}

// The holder an agent on a ticket's branch names (#2572): the panel to go to and who is there, its first name and its
// tool, read from the windows' agent states when the placement does not say them. A sub-agent, or a background agent
// whose lead is known, is its lead's ("Sous-agent"); a signed background agent is its signer's session. An agent with no
// live panel to go to holds nothing: the ticket falls back to its board status, its pull request or its branch, never
// to an anonymous "an agent" with nowhere to go.
function ownerOf(facts: AgentBarFacts, states: AgentStatesData): TicketOwner {
    let blockId = "";
    let name = "";
    let subagent = false;
    if (facts.kind === "panel") {
        blockId = facts.blockId ?? "";
        name = facts.name ?? "";
    } else if (facts.kind === "subagent" || (facts.kind === "background" && !facts.blockId)) {
        blockId = facts.parentBlockId ?? "";
        name = facts.parentName ?? "";
        subagent = true;
    } else {
        blockId = facts.blockId ?? "";
        name = facts.name ?? "";
    }
    const info = blockId ? states?.states?.[blockId] : null;
    if (info == null) {
        return null;
    }
    const tool = agentFacts(facts).cli || agentToolName(info) || "";
    name = (name || info.firstname || "").trim() || tool;
    return { blockId, name, tool: tool.toLowerCase() === name.toLowerCase() ? "" : tool, subagent };
}

// The tickets the Integration panel places this companion's sub-agents on, by the sub-agent's own id (#2522): the
// branch of the worktree it works in, wherever that worktree lies, or the ticket its task starts with. It completes
// what the sub-agent's own records say (certainTicket of its branch and its task), so that the Agents at work block and
// the milestone's rows name the same ticket for it.
export function placedTickets(upcoming: UpcomingAnswer, ownBlockId: string): Map<string, number> {
    const placed = new Map<string, number>();
    if (!ownBlockId) {
        return placed;
    }
    for (const a of upcoming?.agents ?? []) {
        if (a.kind !== "subagent" || a.parentblockid !== ownBlockId || a.state === "done" || !a.agentid) {
            continue;
        }
        const ticket = certainTicket(a.branch, a.description);
        if (ticket > 0 && !placed.has(a.agentid)) {
            placed.set(a.agentid, ticket);
        }
    }
    return placed;
}

// startedHere (#2572): this companion's session started the work of the ticket's worktree (its own panel or one of its
// sub-agents was the first seen at work there, wavesrv's record). With nobody at work in it now, the ticket stays this
// session's: never "in progress, nobody on it" for the session that is busy with it.
function startedHere(ticket: number, branches: Set<string>, inputs: HoldInputs): boolean {
    if (!inputs.ownBlockId) {
        return false;
    }
    return (inputs.upcoming?.starters ?? []).some(
        (s) =>
            s.blockid === inputs.ownBlockId &&
            (branches?.has(s.branch) || branchTicketNumber(s.branch) === ticket)
    );
}

function inThisWorkspace(owner: TicketOwner, inputs: HoldInputs): boolean {
    const workspace = inputs.states?.states?.[owner.blockId]?.workspaceid;
    return !workspace || !inputs.workspaceId || workspace === inputs.workspaceId;
}

// Who holds each ticket: this companion's agent first; else an agent of this workspace, then one of another workspace
// (taken, not named); else, with no agent known, its board status, its open pull request or its branch in a worktree;
// else nobody. A ticket held by no agent but taken anyway is hidden from every list of work to do, except that of the
// agent working on its branch, which is "mine" above.
export function classifyTickets(tickets: MilestoneTicket[], inputs: HoldInputs): Map<number, TicketHold> {
    const holds = new Map<number, TicketHold>();
    const found = candidatesOf(inputs.upcoming, inputs.reviews);
    for (const ticket of tickets ?? []) {
        const n = ticket.number;
        if (inputs.mine?.has(n)) {
            holds.set(n, { kind: "mine" });
            continue;
        }
        const pr = found.prs.get(n);
        const { owners, mine } = ownersOf(n, found.branches.get(n), pr?.number ?? 0, inputs);
        const here = owners.find((o) => inThisWorkspace(o, inputs));
        if (mine || (owners.length === 0 && startedHere(n, found.branches.get(n), inputs))) {
            holds.set(n, { kind: "mine" });
        } else if (here != null) {
            holds.set(n, { kind: "agent", owner: here });
        } else if (owners.length > 0) {
            holds.set(n, { kind: "away", owner: owners[0] });
        } else if (pr != null && statusInReview(ticket.status)) {
            holds.set(n, { kind: "review", pr: pr.number, url: pr.url, status: ticket.status });
        } else if (statusStarted(ticket.status)) {
            holds.set(n, { kind: "status", status: ticket.status });
        } else if (pr != null) {
            holds.set(n, { kind: "pr", pr: pr.number, url: pr.url });
        } else if (found.worktrees.has(n)) {
            holds.set(n, { kind: "branch", branch: found.worktrees.get(n) });
        } else {
            holds.set(n, { kind: "free" });
        }
    }
    return holds;
}

// What makes the placement of the agents out of date: the agent runs the windows know (a start, a close, a restart), not
// their states, which the windows read live.
export function agentsRunKey(data: AgentStatesData): string {
    return Object.values(data?.states ?? {})
        .map((info) => `${info.blockid}@${info.started ?? 0}`)
        .sort()
        .join(",");
}

export type TaskLists = {
    // This agent's tickets, in the order of the agents they are linked to (so that their lines do not cross).
    mine: MilestoneTicket[];
    // The tickets nobody holds, in the forge's order (the most recently updated first).
    free: MilestoneTicket[];
    // The tickets another live agent holds, in the forge's order: never work to do.
    taken: HeldTicket[];
    // The tickets in review with their open pull request (#2454), waiting for the developer: never work to do.
    review: HeldTicket[];
    // The tickets taken that nobody works on (#2454), in the forge's order: never work to do either.
    idle: HeldTicket[];
    // The rows of work shown (mine first, then free), MaxMilestoneRows at most.
    rows: MilestoneTicket[];
    // The tickets nobody holds that are not in rows.
    more: number;
    // The count of each, the milestone's whole open tickets (a read holds at most a hundred): what is not read is free.
    counts: { mine: number; taken: number; review: number; idle: number; free: number };
};

export type HeldTicket = { ticket: MilestoneTicket; hold: TicketHold };

export function taskLists(
    m: MilestoneInfo,
    links: Map<number, LinkAgent[]>,
    holds: Map<number, TicketHold>,
    agents?: LinkAgent[]
): TaskLists {
    const tickets = m?.tickets ?? [];
    const place = new Map((agents ?? []).map((a, i) => [a.id, i]));
    const rank = (t: MilestoneTicket) =>
        Math.min(...(links?.get(t.number) ?? []).map((a) => place.get(a.id) ?? Number.MAX_SAFE_INTEGER));
    const groupOf = (t: MilestoneTicket): HoldGroup =>
        links?.has(t.number) ? "mine" : holdGroup(holds?.get(t.number)?.kind ?? "free");
    const held = (group: HoldGroup) =>
        tickets.filter((t) => groupOf(t) === group).map((ticket) => ({ ticket, hold: holds.get(ticket.number) }));
    const mine = tickets.filter((t) => groupOf(t) === "mine").sort((a, b) => rank(a) - rank(b));
    const free = tickets.filter((t) => groupOf(t) === "free");
    const taken = held("other");
    const review = held("review");
    const idle = held("idle");
    const rows = [...mine, ...free].slice(0, MaxMilestoneRows);
    const remaining = Math.max(m?.remaining ?? 0, tickets.length);
    const freeCount = Math.max(free.length, remaining - mine.length - taken.length - review.length - idle.length);
    const freeShown = rows.length - Math.min(rows.length, mine.length);
    return {
        mine,
        free,
        taken,
        review,
        idle,
        rows,
        more: Math.max(0, freeCount - freeShown),
        counts: {
            mine: mine.length,
            taken: taken.length,
            review: review.length,
            idle: idle.length,
            free: freeCount,
        },
    };
}

// The owners' names a folded group says, each once, in order: "Jérôme, Julie".
export function ownerNames(taken: TaskLists["taken"]): string[] {
    const names: string[] = [];
    for (const { hold } of taken ?? []) {
        const name = hold.kind === "agent" ? hold.owner.name : "";
        if (name && !names.includes(name)) {
            names.push(name);
        }
    }
    return names;
}

// One square per open ticket for the milestone's strip: this agent's, another's, to review, idle (dimmed), free;
// MaxStripSquares at most, since the counts beside the strip carry the rest.
export const MaxStripSquares = 30;

export type StripSquare = "mine" | "other" | "review" | "idle" | "free";

export function stripSquares(counts: TaskLists["counts"]): StripSquare[] {
    const squares: StripSquare[] = [
        ...Array<StripSquare>(counts.mine).fill("mine"),
        ...Array<StripSquare>(counts.taken).fill("other"),
        ...Array<StripSquare>(counts.review).fill("review"),
        ...Array<StripSquare>(counts.idle).fill("idle"),
        ...Array<StripSquare>(counts.free).fill("free"),
    ];
    return squares.slice(0, MaxStripSquares);
}
