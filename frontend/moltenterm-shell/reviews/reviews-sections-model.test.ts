// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews panel's sections by turn (#1061, FR-REV-001 AC12 and AC13, FR-REV-022 AC11, FR-REV-027 AC6): the
// mockup's fixtures (Yours, Agents on it, Blocked, Waiting), both sorts, Upcoming's order and sessions, and Recently
// merged's version groups.

import { describe, expect, it } from "vitest";
import type { AgentStatesData } from "../agent-state-model";
import { cardState } from "./reviews-card-model";
import type { ReviewMergedPr } from "./reviews-merged-model";
import type { ReviewCheck, ReviewPr } from "./reviews-model";
import {
    CardContext,
    cardInputOf,
    cardStates,
    mergedGroups,
    mergedTitle,
    mergedWho,
    sectionOf,
    sectionRows,
    sectionsByTurn,
    upcomingEntries,
    upcomingWaitingCount,
    withTurnShown,
} from "./reviews-sections-model";
import type { AgentBarFacts, UpcomingAnswer, UpcomingBranch } from "./reviews-upcoming-model";

const Green: ReviewCheck[] = [
    { name: "Backend", state: "success" },
    { name: "Frontend", state: "success" },
];

function pr(number: number, over: Partial<ReviewPr> = {}, checks: ReviewCheck[] = Green): ReviewPr {
    const count = (s: string) => checks.filter((c) => c.state === s).length;
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/acme/app/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        headoid: "abc",
        createdat: "",
        updatedat: "",
        merge: "clean",
        ci: {
            state: count("failure") > 0 ? "failure" : count("pending") > 0 ? "pending" : "success",
            success: count("success"),
            failure: count("failure"),
            pending: count("pending"),
            checks,
        },
        report: { state: "present" },
        unpublished: 0,
        ...over,
    };
}

const Now = 10 * 3_600_000;

const States: AgentStatesData = {
    states: {
        nathan: { state: "working", firstname: "Nathan", since: Now - 60_000 },
        diane: { state: "waiting", firstname: "Diane", since: Now - 60_000 },
        salome: { state: "working", firstname: "Salomé", since: Now - 60_000 },
    },
} as unknown as AgentStatesData;

const Upcoming: UpcomingAnswer = {
    dir: "/p",
    branches: [],
    agents: [
        { branch: "feature/1106-x", worktree: "/w/1106", kind: "panel", blockid: "nathan", started: Now - 600_000 },
        { branch: "feature/1110-x", worktree: "/w/1110", kind: "panel", blockid: "diane", started: Now - 600_000 },
    ],
    drafts: [],
    at: Now,
};

const Ctx: CardContext = { upcoming: Upcoming, states: States, now: Now, boardText: (s) => s };

// The mockup's panel: #1101 ready, #1104 review required, #1107 draft ready, #1106 an agent on it (draft),
// #1102 CI failing, #1103 conflicts, #1105 CI running.
function panel(): ReviewPr[] {
    return [
        pr(1105, {}, [...Green, { name: "Build", state: "pending" }]),
        pr(1101),
        pr(1102, {}, [{ name: "Backend", state: "failure", runid: 3 }]),
        pr(1103, { merge: "conflicts" }),
        pr(1104, { merge: "blocked", reviewdecision: "REVIEW_REQUIRED" }),
        pr(1106, { draft: true, merge: "conflicts" }),
        pr(1107, { draft: true }),
    ];
}

function turns(prs: ReviewPr[], sort: "state" | "merge" = "state", ranks?: Record<number, number>) {
    const cards = cardStates(prs, {}, (n) => `/p#${n}`, Ctx);
    return sectionsByTurn(prs, cards, sort, ranks).map((s) => [s.turn, s.prs.map((p) => p.number)]);
}

describe("sections by turn (FR-REV-001 AC12)", () => {
    it("puts every card in its turn's section, in the panel's order", () => {
        expect(turns(panel())).toEqual([
            ["yours", [1104, 1107, 1101]],
            ["agents", [1106]],
            ["blocked", [1103, 1102]],
            ["waiting", [1105]],
        ]);
    });

    it("leaves out a section without a card", () => {
        expect(turns([pr(1101), pr(1105, {}, [{ name: "Build", state: "pending" }])])).toEqual([
            ["yours", [1101]],
            ["waiting", [1105]],
        ]);
        expect(turns([])).toEqual([]);
    });

    it("shows the agents' section for the merge queue's banner, cards or not (#1123)", () => {
        const sections = [
            { turn: "yours" as const, prs: [pr(1101)] },
            { turn: "waiting" as const, prs: [pr(1105)] },
        ];
        expect(withTurnShown(sections, "agents", true).map((s) => [s.turn, s.prs.length])).toEqual([
            ["yours", 1],
            ["agents", 0],
            ["waiting", 1],
        ]);
        expect(withTurnShown(sections, "agents", false)).toBe(sections);
        expect(withTurnShown([], "agents", true).map((s) => s.turn)).toEqual(["agents"]);
        const withAgents = [{ turn: "agents" as const, prs: [pr(1106)] }];
        expect(withTurnShown(withAgents, "agents", true)).toBe(withAgents);
    });

    it("moves a card when its state changes, not when GitHub's draft flag does", () => {
        const draft = pr(1107, { draft: true });
        expect(turns([draft])).toEqual([["yours", [1107]]]);
        const conflicting = { ...draft, merge: "conflicts" as const };
        expect(turns([conflicting])).toEqual([["blocked", [1107]]]);
        // An agent starts on its branch: the card goes to the agents' section.
        const onIt = { ...draft, branch: "feature/1106-x" };
        expect(turns([onIt])).toEqual([["agents", [1107]]]);
    });

    it("by state, cards of one state follow the merge queue's ranks, ranked first (#1062)", () => {
        const ready = [pr(1201), pr(1202), pr(1203), pr(1204)];
        expect(turns(ready, "state", { 1203: 1, 1201: 2, 1204: 3 })).toEqual([["yours", [1203, 1201, 1204, 1202]]]);
    });

    it("sorts by merge order: ranked cards first, the others by state (AC13)", () => {
        expect(turns(panel(), "merge", { 1101: 1, 1104: 2 })[0]).toEqual(["yours", [1101, 1104, 1107]]);
        expect(turns(panel(), "merge", { 1104: 2, 1101: 1 })[0]).toEqual(["yours", [1101, 1104, 1107]]);
    });

    it("walks the open sections only, and finds a card's section", () => {
        const prs = panel();
        const cards = cardStates(prs, {}, (n) => `/p#${n}`, Ctx);
        const sections = sectionsByTurn(prs, cards, "state");
        expect(sectionRows(sections, { blocked: true }).map((p) => p.number)).toEqual([1104, 1107, 1101, 1106, 1105]);
        expect(sectionOf(sections, 1102)).toBe("blocked");
        expect(sectionOf(sections, 9)).toBeNull();
    });

    it("builds the card's input as the card does", () => {
        const draft = pr(1106, { draft: true, merge: "conflicts" });
        const input = cardInputOf(draft, null, Ctx);
        expect(input.agents.map((a) => a.name)).toEqual(["Nathan"]);
        expect(cardState(input).kind).toBe("agent-working");
        const asked = cardInputOf(
            pr(1103, { merge: "conflicts" }),
            { name: "Jeanne", head: "abc", at: Now - 60_000 },
            Ctx
        );
        expect(asked.task?.kind).toBe("rebase");
        expect(asked.rerunnable).toBe(false);
        expect(cardInputOf(pr(1102, {}, [{ name: "Backend", state: "failure", runid: 3 }]), null, Ctx).rerunnable).toBe(
            true
        );
    });

    // #1212: on a Solo board a draft whose agent stopped before marking it ready (its terminal idle on the branch) is
    // still its agent's, with Resume; "Ready" is never said of a draft. With Human Testing it stays the developer's.
    it("keeps a Solo draft with its stopped agent and offers to resume it", () => {
        const quick: ReviewCheck[] = [
            ...Green,
            { name: "Build", state: "neutral" },
            { name: "Test", state: "neutral" },
        ];
        const draft = pr(1209, { draft: true }, quick);
        const states = {
            states: { ...States.states, olivia: { state: "idle", firstname: "Olivia", since: Now - 60_000 } },
        } as unknown as AgentStatesData;
        const agent = {
            branch: "feature/1209-x",
            worktree: "/w/1209",
            kind: "panel" as const,
            blockid: "olivia",
            started: Now - 600_000,
        };
        const ctx = (humantesting: "yes" | "no"): CardContext => ({
            ...Ctx,
            states,
            upcoming: {
                ...Upcoming,
                humantesting,
                agents: [...Upcoming.agents, agent],
                drafts: [{ branch: "feature/1209-x", ticket: 1209, status: "AI Testing" }],
            },
        });
        const solo = cardState(cardInputOf(draft, null, ctx("no")));
        expect(solo.kind).toBe("agent-finish");
        expect(solo.turn).toBe("agents");
        expect(solo.primary?.id).toBe("resume");
        expect(solo.primary?.label).toEqual({
            key: "reviews.card.action.resume",
            vars: { name: { key: "reviews.card.name", vars: { name: "Olivia" } } },
        });
        expect(solo.molten).toBe(false);
        expect(solo.sentence).toEqual({ key: "reviews.card.state.agentFinish" });
        const sections = sectionsByTurn(
            [draft],
            cardStates([draft], {}, (n) => `/p#${n}`, ctx("no")),
            "state"
        );
        expect(sections.map((s) => s.turn)).toEqual(["agents"]);
        const gated = cardState(cardInputOf(draft, null, ctx("yes")));
        expect(gated.kind).toBe("draft-ready");
        expect(gated.turn).toBe("yours");
        expect(gated.primary?.id).toBe("mark-ready");
        expect(gated.sentence).toEqual({ key: "reviews.card.state.draftReady" });
    });

    // #1172: on a Solo board (no Human Testing) a draft is the agents' turn, its column known or not; with Human
    // Testing, the human gates make it the developer's.
    it("puts a draft in Agents on it in a workflow without Human Testing, whatever its column says", () => {
        const drafts = [pr(1169, { draft: true }), pr(1161, { draft: true }), pr(1170, { draft: true })];
        const solo: CardContext = {
            ...Ctx,
            upcoming: {
                ...Upcoming,
                humantesting: "no",
                drafts: [
                    { branch: "feature/1169-x", ticket: 1163, status: "AI Testing" },
                    { branch: "feature/1161-x", ticket: 1152 },
                ],
            },
        };
        const sections = (ctx: CardContext) =>
            sectionsByTurn(
                drafts,
                cardStates(drafts, {}, (n) => `/p#${n}`, ctx),
                "state"
            ).map((s) => [s.turn, s.prs.map((p) => p.number)]);
        expect(sections(solo)).toEqual([["agents", [1169, 1161, 1170]]]);
        const gated: CardContext = {
            ...Ctx,
            upcoming: {
                ...Upcoming,
                humantesting: "yes",
                drafts: [
                    { branch: "feature/1169-x", ticket: 1163, status: "Human Testing" },
                    { branch: "feature/1161-x", ticket: 1152, status: "AI Testing" },
                    { branch: "feature/1170-x", ticket: 1170 },
                ],
            },
        };
        expect(sections(gated)).toEqual([
            ["yours", [1169, 1170]],
            ["agents", [1161]],
        ]);
    });
});

function branch(ticket: number): UpcomingBranch {
    return { branch: `feature/${ticket}-x`, ticket, ahead: 1, title: `Ticket ${ticket}` };
}

const Diane: AgentBarFacts = { kind: "panel", blockId: "diane", name: "Diane", state: "waiting", since: 1 };
const Sub = (state: AgentBarFacts["state"]): AgentBarFacts => ({
    kind: "subagent",
    name: "",
    state,
    since: 1,
    parentBlockId: "salome",
    parentName: "Salomé",
});
const Back: AgentBarFacts = {
    kind: "background",
    name: "",
    state: "background",
    since: 1,
    parentBlockId: "salome",
    parentName: "Salomé",
};

describe("Upcoming (FR-REV-022 AC11)", () => {
    const agents: Record<string, AgentBarFacts> = {
        "feature/1110-x": Diane,
        "feature/1111-x": Sub("working"),
        "feature/1112-x": Sub("done"),
        "feature/1113-x": Back,
    };
    const rows = [branch(1114), branch(1111), branch(1110), branch(1112), branch(1113)];

    it("puts an agent waiting first, groups a session's agents, then the branches nobody is on", () => {
        const entries = upcomingEntries(rows, (b) => agents[b] ?? null);
        expect(
            entries.map((e) => (e.kind === "session" ? e.items.map((i) => i.branch.ticket) : e.item.branch.ticket))
        ).toEqual([1110, [1111, 1112, 1113], 1114]);
        const session = entries[1];
        expect(session.kind === "session" && session.parentName).toBe("Salomé");
        expect(upcomingWaitingCount(entries)).toBe(1);
    });

    it("keeps a lone sub-agent as its own card", () => {
        const entries = upcomingEntries([branch(1111), branch(1114)], (b) => agents[b] ?? null);
        expect(entries.map((e) => e.kind)).toEqual(["branch", "branch"]);
    });

    it("puts a session whose panel waits first", () => {
        const entries = upcomingEntries(
            [branch(1114), branch(1111), branch(1112)],
            (b) => agents[b] ?? null,
            (blockId) => blockId === "salome"
        );
        expect(entries[0].kind).toBe("session");
        expect(entries[0].waiting).toBe(true);
    });
});

function merged(number: number, extra: Partial<ReviewMergedPr> = {}): ReviewMergedPr {
    return {
        number,
        title: `PR ${number}`,
        url: "",
        branch: `fix/${number}-x`,
        base: "develop",
        author: "AGachet",
        mergedby: "AGachet",
        mergedat: "2026-10-25T00:00:00Z",
        ...extra,
    };
}

describe("Recently merged groups (FR-REV-027 AC6)", () => {
    it("groups by version: next first, then each tag in order, then unknown", () => {
        const groups = mergedGroups([
            merged(1, { ships: "tag", shipsin: "v1.0.0-6" }),
            merged(2, { ships: "next" }),
            merged(3),
            merged(4, { ships: "branch", shipsin: "release" }),
            merged(5, { ships: "tag", shipsin: "v1.0.0-5" }),
            merged(6, { ships: "tag", shipsin: "v1.0.0-6" }),
        ]);
        expect(groups.map((g) => [g.key, g.prs.map((p) => p.number)])).toEqual([
            ["next", [2, 4]],
            ["tag:v1.0.0-6", [1, 6]],
            ["tag:v1.0.0-5", [5]],
            ["unknown", [3]],
        ]);
    });

    it("drops the ticket prefix the title repeats", () => {
        expect(mergedTitle(merged(1, { title: "[#1050] Terminal header icon" }))).toBe("Terminal header icon");
        expect(mergedTitle(merged(1, { title: "Plain title" }))).toBe("Plain title");
        expect(mergedTitle(merged(1, { title: "[#1050]" }))).toBe("[#1050]");
    });

    it("names others, never the developer who merged", () => {
        const model = (m: string) => (m === "opus" ? "Opus 5.5" : "");
        expect(mergedWho(merged(1, { agents: [{ firstname: "Paul", model: "opus" }] }), model)).toEqual({
            agent: "Paul",
            model: "Opus 5.5",
        });
        expect(mergedWho(merged(1), model)).toEqual({ you: true });
        expect(mergedWho(merged(1, { author: "ana" }), model)).toEqual({ author: "ana" });
        expect(mergedWho(merged(1, { reviewed: { name: "AGachet", date: "" } }), model)).toEqual({ you: true });
        expect(mergedWho(merged(1, { reviewed: { name: "bob", date: "" } }), model)).toEqual({
            you: true,
            reviewer: "bob",
        });
    });
});
