// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    AllLeads,
    EveryLead,
    Flore,
    Jerome,
    Julie,
    linksOf,
    nineOpen,
    NineTickets,
    OtherWorkspace,
    panelOn,
    Remy,
    reviewsOf,
    statesOf,
    subagent,
    ThisWorkspace,
    ticketsOf,
    upcomingOf,
} from "./companion-holds-fixture";
import {
    agentsRunKey,
    classifyTickets,
    holdGroup,
    HoldInputs,
    HoldKind,
    MaxStripSquares,
    ownerNames,
    placedTickets,
    statusInProgress,
    statusInReview,
    statusStarted,
    stripSquares,
    taskLists,
    TicketHold,
} from "./companion-holds-model";
import { MaxMilestoneRows, subagentTicket } from "./companion-milestone-model";

function inputs(own: typeof Flore, mine: number[], more: Partial<HoldInputs> = {}): HoldInputs {
    return {
        mine: linksOf(...mine),
        ownBlockId: own.blockid,
        workspaceId: ThisWorkspace,
        upcoming: AllLeads,
        reviews: null,
        states: EveryLead,
        ...more,
    };
}

function kinds(holds: Map<number, TicketHold>): string {
    return [...holds.entries()].map(([n, h]) => `${n}:${h.kind}`).join(" ");
}

function ownerOf(holds: Map<number, TicketHold>, n: number): string {
    const hold = holds.get(n);
    return hold?.kind === "agent"
        ? `${hold.owner.name} · ${hold.owner.tool}${hold.owner.subagent ? " (sub-agent)" : ""}`
        : "";
}

// The developer's case (#2418, TC-SHELL-018-8): Lead A (Claude Code) has 3 sub-agents on tickets 1 to 3, lead B (Kimi) 2 on
// tickets 4 and 5, lead C (Claude Code) 1 on ticket 6. Tickets 7 to 9 are free.
describe("who holds each ticket: three leads and their sub-agents", () => {
    it("lists, in A's companion, 1 to 3 as its own and 7 to 9 as free; 4 to 6 are taken, by their leads", () => {
        const holds = classifyTickets(NineTickets, inputs(Flore, [1, 2, 3]));
        expect(kinds(holds)).toBe("1:mine 2:mine 3:mine 4:agent 5:agent 6:agent 7:free 8:free 9:free");
        expect(ownerOf(holds, 4)).toBe("Jérôme · Kimi Code (sub-agent)");
        expect(ownerOf(holds, 5)).toBe("Jérôme · Kimi Code (sub-agent)");
        expect(ownerOf(holds, 6)).toBe("Julie · Claude Code (sub-agent)");
        const lists = taskLists(nineOpen(), linksOf(1, 2, 3), holds);
        expect(lists.mine.map((t) => t.number)).toEqual([1, 2, 3]);
        expect(lists.free.map((t) => t.number)).toEqual([7, 8, 9]);
        expect(lists.taken.map((t) => t.ticket.number)).toEqual([4, 5, 6]);
        expect(lists.rows.map((t) => t.number)).toEqual([1, 2, 3, 7, 8, 9]);
    });

    it("lists, in B's companion, 4 and 5 as its own and 7 to 9 as free", () => {
        const holds = classifyTickets(NineTickets, inputs(Jerome, [4, 5]));
        expect(kinds(holds)).toBe("1:agent 2:agent 3:agent 4:mine 5:mine 6:agent 7:free 8:free 9:free");
        const lists = taskLists(nineOpen(), linksOf(4, 5), holds);
        expect(lists.rows.map((t) => t.number)).toEqual([4, 5, 7, 8, 9]);
        expect(ownerOf(holds, 1)).toBe("Flore · Claude Code (sub-agent)");
    });

    it("lists, in C's companion, 6 as its own and 7 to 9 as free", () => {
        const holds = classifyTickets(NineTickets, inputs(Julie, [6]));
        const lists = taskLists(nineOpen(), linksOf(6), holds);
        expect(lists.rows.map((t) => t.number)).toEqual([6, 7, 8, 9]);
        expect(lists.taken.map((t) => t.ticket.number)).toEqual([1, 2, 3, 4, 5]);
    });

    it("says nothing of other agents before wavesrv answered: the tickets that are not its own are free", () => {
        const holds = classifyTickets(NineTickets, inputs(Flore, [1, 2, 3], { upcoming: null, states: statesOf() }));
        expect(kinds(holds)).toBe("1:mine 2:mine 3:mine 4:free 5:free 6:free 7:free 8:free 9:free");
    });

    it("never counts this companion's own agent or its sub-agents as another's", () => {
        // wavesrv may place A's sub-agent on a ticket the companion did not link (its link is stricter): it is still
        // A's, its own work (#2522).
        const answer = upcomingOf([panelOn(Flore, "develop"), subagent(Flore, 9), subagent(Jerome, 4)]);
        const holds = classifyTickets(NineTickets, inputs(Flore, [], { upcoming: answer }));
        expect(holds.get(9)).toEqual({ kind: "mine" });
        expect(holds.get(4)?.kind).toBe("agent");
        const own = upcomingOf([panelOn(Flore, "feature/9-work")]);
        expect(classifyTickets(NineTickets, inputs(Flore, [], { upcoming: own })).get(9)).toEqual({ kind: "mine" });
        expect(classifyTickets(NineTickets, inputs(Jerome, [], { upcoming: own })).get(9)?.kind).toBe("agent");
    });
});

// #2522: Pauline's sub-agent "Build #1320 meeting images" works in ../Notulia-1320, a worktree beside the project folder
// on the ticket's branch, while its records name the main checkout (on develop). Its task names #1320, but not first.
describe("a sub-agent in a worktree beside the project folder (#2522)", () => {
    const sibling = "/Notulia-1320";
    const branch = "feature/1320-meeting-images";
    const tickets = ticketsOf(1320).map((t) => ({ ...t, status: "In progress" }));
    const placedSub = (lead: typeof Flore) =>
        subagent(lead, 1320, "running", {
            branch,
            worktree: sibling,
            description: "Build #1320 meeting images",
            agentid: "a0ef11c100895d164",
        });
    const worktreeBranch = [{ branch, ticket: 1320, ahead: 1, worktree: sibling }];

    it("makes the ticket the lead's own work, linked to that sub-agent", () => {
        const answer = upcomingOf([panelOn(Flore, "develop"), placedSub(Flore)], worktreeBranch);
        const holds = classifyTickets(tickets, inputs(Flore, [], { upcoming: answer }));
        expect(holds.get(1320)).toEqual({ kind: "mine" });
        const placed = placedTickets(answer, Flore.blockid);
        expect(placed.get("a0ef11c100895d164")).toBe(1320);
        // Its records name develop and a task that does not start with #1320: the placement names its ticket.
        expect(subagentTicket("develop", "Build #1320 meeting images", "a0ef11c100895d164", placed)).toBe(1320);
        expect(subagentTicket("develop", "Build #1320 meeting images", "a0ef11c100895d164")).toBe(0);
        const m = { number: 1, title: "v1.0.0", open: 1, closed: 0, remaining: 1, tickets };
        const links = linksOf(1320);
        const lists = taskLists(m, links, holds);
        expect(lists.mine.map((t) => t.number)).toEqual([1320]);
        expect(lists.taken).toEqual([]);
        expect(lists.idle).toEqual([]);
    });

    it("leaves another lead's sub-agent under taken by others, named and linked to its lead", () => {
        const answer = upcomingOf([panelOn(Julie, "develop"), placedSub(Julie)], worktreeBranch);
        const holds = classifyTickets(tickets, inputs(Flore, [], { upcoming: answer }));
        expect(holds.get(1320)).toEqual({
            kind: "agent",
            owner: { blockId: Julie.blockid, name: "Julie", tool: "Claude Code", subagent: true },
        });
        expect(placedTickets(answer, Flore.blockid).size).toBe(0);
    });

    it("keeps a worktree branch no agent is on a branch hold", () => {
        const answer = upcomingOf([panelOn(Flore, "develop")], worktreeBranch);
        const holds = classifyTickets(ticketsOf(1320), inputs(Flore, [], { upcoming: answer }));
        expect(holds.get(1320)).toEqual({ kind: "branch", branch });
    });
});

describe("a ticket held by no agent MoltenTerm knows", () => {
    const answer = upcomingOf([]);

    it("is taken when its board status is In progress or later, and offered while it is Backlog or Ready", () => {
        const tickets = ticketsOf(1, 2, 3, 4, 5).map((t, i) => ({
            ...t,
            status: ["In progress", "AI testing", "Backlog", "Ready", ""][i],
        }));
        const holds = classifyTickets(tickets, inputs(Flore, [], { upcoming: answer }));
        expect(kinds(holds)).toBe("1:status 2:status 3:free 4:free 5:free");
        expect(holds.get(2)).toEqual({ kind: "status", status: "AI testing" });
        for (const status of ["In Progress", "in  review", "Human Testing", "Done", "Doing", "QA"]) {
            expect(statusStarted(status)).toBe(true);
        }
        for (const status of ["", "Backlog", " backlog ", "Ready", "Todo", "To do", undefined]) {
            expect(statusStarted(status)).toBe(false);
        }
    });

    it("is idle, not with others, while no live agent works on it (#2454)", () => {
        const tickets = ticketsOf(1, 2, 3, 4).map((t, i) => ({
            ...t,
            status: ["In progress", "In review", "", ""][i],
        }));
        const m = { number: 1, title: "1.1.0", open: 4, closed: 0, remaining: 4, tickets };
        const lists = taskLists(m, new Map(), classifyTickets(tickets, inputs(Flore, [], { upcoming: answer })));
        expect(lists.idle.map((h) => h.ticket.number)).toEqual([1, 2]);
        expect(lists.taken).toEqual([]);
        expect(lists.counts).toEqual({ mine: 0, taken: 0, review: 0, idle: 2, free: 2 });
        expect(lists.rows.map((r) => r.number)).toEqual([3, 4]);
        expect(lists.more).toBe(0);
        expect(holdGroup("agent")).toBe("other");
        expect(holdGroup("away")).toBe("other");
        expect(["status", "pr", "branch"].map((k) => holdGroup(k as HoldKind))).toEqual(["idle", "idle", "idle"]);
        expect(holdGroup("mine")).toBe("mine");
        expect(holdGroup("free")).toBe("free");
    });

    it("stays with others while another session's live agent holds it, In progress or not (#2454)", () => {
        const tickets = ticketsOf(4, 6).map((t) => ({ ...t, status: "In progress" }));
        const m = { number: 1, title: "1.1.0", open: 2, closed: 0, remaining: 2, tickets };
        const lists = taskLists(m, linksOf(), classifyTickets(tickets, inputs(Flore, [])));
        expect(lists.taken.map((h) => h.ticket.number)).toEqual([4, 6]);
        expect(lists.idle).toEqual([]);
        expect(lists.counts).toEqual({ mine: 0, taken: 2, review: 0, idle: 0, free: 0 });
    });

    it("keeps this session's sub-agents' tickets here even when they are In progress (#2454)", () => {
        const tickets = ticketsOf(1, 2).map((t) => ({ ...t, status: "In progress" }));
        const m = { number: 1, title: "1.1.0", open: 2, closed: 0, remaining: 2, tickets };
        const lists = taskLists(m, linksOf(1, 2), classifyTickets(tickets, inputs(Flore, [1, 2])));
        expect(lists.mine.map((t) => t.number)).toEqual([1, 2]);
        expect(lists.counts).toEqual({ mine: 2, taken: 0, review: 0, idle: 0, free: 0 });
    });

    it("is hidden everywhere but in the companion of the agent working on its branch", () => {
        const tickets = ticketsOf(1).map((t) => ({ ...t, status: "In progress" }));
        expect(classifyTickets(tickets, inputs(Jerome, [], { upcoming: answer })).get(1)?.kind).toBe("status");
        expect(classifyTickets(tickets, inputs(Flore, [1], { upcoming: answer })).get(1)?.kind).toBe("mine");
    });

    it("is taken when it has an open pull request, draft or not", () => {
        const holds = classifyTickets(
            ticketsOf(7, 8),
            inputs(Flore, [], {
                upcoming: answer,
                reviews: reviewsOf({
                    number: 91,
                    ticket: 7,
                    branch: "feature/7-x",
                    url: "https://example.test/pull/91",
                }),
            })
        );
        expect(holds.get(7)).toEqual({ kind: "pr", pr: 91, url: "https://example.test/pull/91" });
        expect(holds.get(8)).toEqual({ kind: "free" });
        const byBranch = classifyTickets(
            ticketsOf(8),
            inputs(Flore, [], { upcoming: answer, reviews: reviewsOf({ number: 92, branch: "fix/8-y" }) })
        );
        expect(byBranch.get(8)?.kind).toBe("pr");
        const draft = classifyTickets(
            ticketsOf(8),
            inputs(Flore, [], { upcoming: upcomingOf([], []), reviews: { dir: "/shop", ready: [], drafts: [] } })
        );
        expect(draft.get(8)?.kind).toBe("free");
    });

    it("is taken when its branch is in a worktree, not when it is only on the remote", () => {
        const branches = [
            { branch: "feature/7-x", ticket: 7, ahead: 2, worktree: "/shop/.worktrees/7" },
            { branch: "feature/8-y", ticket: 8, ahead: 1, remote: true },
        ];
        const holds = classifyTickets(ticketsOf(7, 8), inputs(Flore, [], { upcoming: upcomingOf([], branches) }));
        expect(holds.get(7)).toEqual({ kind: "branch", branch: "feature/7-x" });
        expect(holds.get(8)).toEqual({ kind: "free" });
    });

    it("is to review when In review with its open pull request, and an agent comes before both (#2454)", () => {
        const tickets = ticketsOf(4, 7).map((t) => ({ ...t, status: "In review" }));
        const reviews = reviewsOf({ number: 91, ticket: 7, branch: "feature/7-x" }, { number: 94, ticket: 4 });
        const holds = classifyTickets(tickets, inputs(Flore, [], { reviews }));
        expect(holds.get(7)).toEqual({ kind: "review", pr: 91, url: undefined, status: "In review" });
        expect(holds.get(4)?.kind).toBe("agent");
    });

    it("tells to review from idle: In review with a PR, In review without one, AI testing with no agent (#2454)", () => {
        const tickets = ticketsOf(1, 2, 3, 5).map((t, i) => ({
            ...t,
            status: ["In review", "In review", "AI testing", "Backlog"][i],
        }));
        const reviews = reviewsOf(
            { number: 91, ticket: 1, branch: "feature/1-x", url: "https://example.test/pull/91" },
            { number: 95, ticket: 5, branch: "feature/5-x" }
        );
        const holds = classifyTickets(tickets, inputs(Flore, [], { upcoming: answer, reviews }));
        expect(kinds(holds)).toBe("1:review 2:status 3:status 5:pr");
        const m = { number: 1, title: "1.1.0", open: 4, closed: 0, remaining: 4, tickets };
        const lists = taskLists(m, new Map(), holds);
        expect(lists.review.map((h) => h.ticket.number)).toEqual([1]);
        expect(lists.idle.map((h) => h.ticket.number)).toEqual([2, 3, 5]);
        expect(lists.counts).toEqual({ mine: 0, taken: 0, review: 1, idle: 3, free: 0 });
        expect(stripSquares(lists.counts)).toEqual(["review", "idle", "idle", "idle"]);
        expect(statusInReview("Code review")).toBe(true);
        expect(statusInReview("In progress")).toBe(false);
        expect(statusInProgress(" in  progress ")).toBe(true);
        expect(statusInProgress("AI testing")).toBe(false);
    });
});

describe("an agent that stops holding", () => {
    function withSub(state: "running" | "quiet" | "done") {
        return upcomingOf([panelOn(Jerome, "develop"), subagent(Jerome, 7, state)]);
    }

    it("gives its ticket back to every list when a sub-agent finishes or goes quiet, with nothing else holding it", () => {
        for (const state of ["done", "quiet"] as const) {
            const holds = classifyTickets(NineTickets, inputs(Flore, [], { upcoming: withSub(state) }));
            expect(holds.get(7)).toEqual({ kind: "free" });
        }
        expect(classifyTickets(NineTickets, inputs(Flore, [], { upcoming: withSub("running") })).get(7)?.kind).toBe(
            "agent"
        );
    });

    it("keeps it taken when its board status or an open pull request still says so", () => {
        const tickets = ticketsOf(7).map((t) => ({ ...t, status: "In progress" }));
        expect(classifyTickets(tickets, inputs(Flore, [], { upcoming: withSub("done") })).get(7)?.kind).toBe("status");
        const reviews = reviewsOf({ number: 91, ticket: 7, branch: "feature/7-x" });
        expect(
            classifyTickets(ticketsOf(7), inputs(Flore, [], { upcoming: withSub("done"), reviews })).get(7)?.kind
        ).toBe("pr");
    });

    it("does not hold a ticket for a panel that only passed through its worktree", () => {
        const visiting = upcomingOf([panelOn(Jerome, "feature/7-x", { visiting: true })]);
        expect(classifyTickets(ticketsOf(7), inputs(Flore, [], { upcoming: visiting })).get(7)).toEqual({
            kind: "free",
        });
        const working = upcomingOf([panelOn(Jerome, "feature/7-x")]);
        const holds = classifyTickets(ticketsOf(7), inputs(Flore, [], { upcoming: working }));
        expect(ownerOf(holds, 7)).toBe("Jérôme · Kimi Code");
    });

    it("does not hold a ticket for a terminal the windows no longer know", () => {
        const gone = classifyTickets(
            ticketsOf(7),
            inputs(Flore, [], { upcoming: upcomingOf([panelOn(Jerome, "feature/7-x")]), states: statesOf(Flore) })
        );
        expect(gone.get(7)).toEqual({ kind: "free" });
    });
});

describe("agents of other workspaces and of other providers", () => {
    it("takes a ticket an agent of another workspace holds without naming that agent", () => {
        const answer = upcomingOf([panelOn(Remy, "feature/7-x"), subagent(Remy, 8)]);
        const holds = classifyTickets(ticketsOf(7, 8, 9), inputs(Flore, [], { upcoming: answer }));
        expect(kinds(holds)).toBe("7:away 8:away 9:free");
        expect(JSON.stringify([...holds.values()])).not.toContain("Rémy");
        const all = classifyTickets(NineTickets, inputs(Flore, [], { upcoming: answer }));
        const lists = taskLists(nineOpen(), new Map(), all);
        expect(lists.free.map((t) => t.number)).toEqual([1, 2, 3, 4, 5, 6, 9]);
        expect(lists.taken.map((t) => t.ticket.number)).toEqual([7, 8]);
    });

    it("names an agent of this workspace before one of another when both work on the ticket", () => {
        const answer = upcomingOf([panelOn(Remy, "feature/7-x"), subagent(Jerome, 7)]);
        const holds = classifyTickets(ticketsOf(7), inputs(Flore, [], { upcoming: answer }));
        expect(ownerOf(holds, 7)).toBe("Jérôme · Kimi Code (sub-agent)");
    });

    it("holds the same whatever the provider: Codex, Kimi and Claude Code panels and sub-agents alike", () => {
        const codex = statesOf(Flore, { ...Remy, workspaceid: ThisWorkspace });
        const answer = upcomingOf([panelOn(Remy, "feature/7-x"), subagent(Remy, 8)]);
        const holds = classifyTickets(ticketsOf(7, 8), inputs(Flore, [], { upcoming: answer, states: codex }));
        expect(ownerOf(holds, 7)).toBe("Rémy · Codex");
        expect(ownerOf(holds, 8)).toBe("Rémy · Codex (sub-agent)");
        expect(OtherWorkspace).not.toBe(ThisWorkspace);
    });

    it("finds a sub-agent still on its own worktree-agent branch by the ticket its description starts with", () => {
        const answer = upcomingOf([
            subagent(Jerome, 7, "running", { branch: "worktree-agent-ab12", description: "#7 smooth the switch" }),
            subagent(Julie, 8, "running", { branch: "worktree-agent-cd34", description: "Port the fix from #8" }),
        ]);
        const holds = classifyTickets(ticketsOf(7, 8), inputs(Flore, [], { upcoming: answer }));
        expect(holds.get(7)?.kind).toBe("agent");
        // A #N elsewhere than at the start names another ticket as often as its own: never a hold.
        expect(holds.get(8)?.kind).toBe("free");
    });
});

describe("the lists and counts of a milestone", () => {
    it("never counts the tickets other agents hold in 'and N more', and counts what a read leaves out as free", () => {
        const many = {
            ...nineOpen(),
            open: 41,
            remaining: 41,
            tickets: ticketsOf(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14),
        };
        const holds = classifyTickets(many.tickets, inputs(Flore, [1, 2, 3]));
        const lists = taskLists(many, linksOf(1, 2, 3), holds);
        expect(lists.rows).toHaveLength(MaxMilestoneRows);
        expect(lists.rows.map((t) => t.number)).toEqual([1, 2, 3, 7, 8, 9, 10, 11]);
        // 41 open: 3 here, 3 with others, the other 35 free; 5 of them shown.
        expect(lists.counts).toEqual({ mine: 3, taken: 3, review: 0, idle: 0, free: 35 });
        expect(lists.more).toBe(30);
        const noneFree = taskLists(
            { ...nineOpen(), tickets: ticketsOf(4, 5, 6), remaining: 3, open: 3 },
            new Map(),
            classifyTickets(ticketsOf(4, 5, 6), inputs(Flore, []))
        );
        expect(noneFree.more).toBe(0);
        expect(noneFree.counts).toEqual({ mine: 0, taken: 3, review: 0, idle: 0, free: 0 });
        expect(noneFree.rows).toEqual([]);
    });

    it("shows this agent's tickets first in the order of its agents, so that their lines do not cross", () => {
        const holds = classifyTickets(NineTickets, inputs(Flore, [1, 2, 3]));
        const agents = [3, 1, 2].map((n) => ({ ...linksOf(n).get(n)[0] }));
        const lists = taskLists(nineOpen(), linksOf(1, 2, 3), holds, agents);
        expect(lists.mine.map((t) => t.number)).toEqual([3, 1, 2]);
    });

    it("names the owners once each, in order, for the folded group", () => {
        const holds = classifyTickets(NineTickets, inputs(Flore, [1, 2, 3]));
        const lists = taskLists(nineOpen(), linksOf(1, 2, 3), holds);
        expect(ownerNames(lists.taken)).toEqual(["Jérôme", "Julie"]);
        expect(ownerNames([])).toEqual([]);
    });

    it("draws one square per open ticket, this agent's first, then another's, then idle, then free, thirty at most", () => {
        expect(stripSquares({ mine: 2, taken: 1, review: 0, idle: 2, free: 3 })).toEqual([
            "mine",
            "mine",
            "other",
            "idle",
            "idle",
            "free",
            "free",
            "free",
        ]);
        expect(stripSquares({ mine: 0, taken: 0, review: 0, idle: 0, free: 0 })).toEqual([]);
        expect(stripSquares({ mine: 3, taken: 3, review: 0, idle: 0, free: 100 })).toHaveLength(MaxStripSquares);
        expect(stripSquares({ mine: 40, taken: 0, review: 0, idle: 0, free: 0 }).every((s) => s === "mine")).toBe(true);
    });

    it("tells that the agents changed from the runs the windows know, not from their states", () => {
        const a = agentsRunKey(statesOf(Flore, Jerome));
        expect(agentsRunKey(statesOf(Jerome, Flore))).toBe(a);
        expect(agentsRunKey(statesOf(Flore, Jerome, Julie))).not.toBe(a);
        expect(agentsRunKey(statesOf({ ...Flore, state: "waiting" }, Jerome))).toBe(a);
        expect(agentsRunKey(statesOf({ ...Flore, started: 5 }, Jerome))).not.toBe(a);
        expect(agentsRunKey(null)).toBe("");
    });
});
