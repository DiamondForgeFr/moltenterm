// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews panel's sections by whose turn it is (#1061, FR-REV-001 AC12 and AC13, FR-REV-022 AC11, FR-REV-027 AC6
// to AC8): the cards' one state (reviews-card-model.ts) sorts them into Yours, Agents on it, Blocked and Waiting; the
// header's sort orders each section by state or by the suggested merge order; Upcoming puts what waits for the
// developer first and groups sub-agents under their session; Recently merged groups the PRs by the version that ships
// them. Pure, so the list and each card read the same state.

import type { AgentStatesData } from "../agent-state-model";
import { batchWorkItem, withBatchAgent } from "./reviews-batch-agent";
import type { BatchRun } from "./reviews-batch-model";
import { CardInput, CardState, cardState, CardStateKinds, CardTurn } from "./reviews-card-model";
import type { ReviewMergedPr } from "./reviews-merged-model";
import { checksOf, RebaseAsk, ReviewPr } from "./reviews-model";
import { headStillFails, PrTask, prTaskState, taskAgent, taskAgentLive } from "./reviews-task-model";
import {
    AgentBarFacts,
    branchAgents,
    DraftActiveMs,
    draftTurn,
    prOtherBranches,
    UpcomingAnswer,
    UpcomingBranch,
} from "./reviews-upcoming-model";

// The PR sections, in the order the panel shows them.
export const TurnOrder: CardTurn[] = ["yours", "agents", "blocked", "waiting"];

// must match the sort choices of reviews-order-store.ts; "learn" joins with the learning grades (#788, #1064).
export type ReviewsSort = "state" | "merge";

// A merged group shows this many rows, then "… N more · Show all".
export const MergedGroupRows = 6;

// What a card's state is computed from besides the PR: wavesrv's placement of the agents, the windows' agent states,
// the minute clock, the board column worded and the project's merge queue for a base (#1128).
export type CardContext = {
    upcoming: UpcomingAnswer;
    states: AgentStatesData;
    now: number;
    boardText: (status: string) => string;
    batchRun?: (base: string) => BatchRun;
};

// cardAgents: every agent of the PR's branch, and the merge queue's agent while the queue works on the PR (#1128).
export function cardAgents(pr: ReviewPr, ctx: CardContext): AgentBarFacts[] {
    const agents = branchAgents(ctx.upcoming, ctx.states, pr.branch);
    return withBatchAgent(agents, ctx.batchRun?.(pr.base), pr, ctx.states);
}

// cardInputOf: the card state's input for a PR, as the card reads it (its agents, its task, its draft turn); the list
// and the card both build it here, so a card's section never disagrees with its own state.
export function cardInputOf(pr: ReviewPr, ask: RebaseAsk, ctx: CardContext): CardInput {
    const run = ctx.batchRun?.(pr.base);
    const batchItem = batchWorkItem(run, pr);
    const agents = cardAgents(pr, ctx);
    const task: PrTask = ask != null ? { ...ask, kind: ask.kind ?? "rebase" } : null;
    const owner = taskAgent(task, agents, ctx.states);
    const live = taskAgentLive(task, owner);
    const taskState = prTaskState(task, pr, owner, ctx.now);
    let boardTurn = null;
    let boardStatus = "";
    const draft = pr.draft && ctx.upcoming != null ? ctx.upcoming.drafts?.find((d) => d.branch === pr.branch) : null;
    // A draft the upcoming answer does not list still gets its workflow's turn (#1172): in a workflow without Human
    // Testing it is the agent's.
    const workflowTurn = ctx.upcoming?.humantesting === "no";
    if (pr.draft && ctx.upcoming != null && (draft != null || agents.length > 0 || workflowTurn)) {
        const turn = draftTurn(agents[0] ?? null, draft, ctx.now, ctx.upcoming.humantesting);
        boardTurn = agents.length === 0 ? turn : null;
        boardStatus = turn.status ? ctx.boardText(turn.status) : "";
    }
    return {
        pr,
        agents,
        task,
        taskState,
        taskOwner: owner,
        taskLive: live,
        boardTurn,
        boardStatus,
        agentReadies: pr.draft && workflowTurn,
        recentCommit: !!draft?.commitat && ctx.now - draft.commitat < DraftActiveMs,
        headFails: headStillFails(pr, agents[0] ?? null, taskState),
        rerunnable: checksOf(pr.ci, "failure").some((c) => (c.runid ?? 0) > 0),
        others: prOtherBranches(ctx.upcoming, pr),
        batch: batchItem != null ? { run, item: batchItem } : undefined,
    };
}

export function cardStates(
    prs: readonly ReviewPr[],
    asks: Record<string, RebaseAsk>,
    askKey: (number: number) => string,
    ctx: CardContext
): Record<number, CardState> {
    const rtn: Record<number, CardState> = {};
    for (const pr of prs) {
        rtn[pr.number] = cardState(cardInputOf(pr, asks?.[askKey(pr.number)], ctx));
    }
    return rtn;
}

export type TurnSection = { turn: CardTurn; prs: ReviewPr[] };

// sectionsByTurn: the PR cards by whose turn it is, each section ordered by the sort chosen. By state: the state's
// precedence, then the merge queue's rank, ranked cards first (#1062: the queue at the top of Yours reads in the
// cards' order), then the list's own order (newest update first). By merge order: ranked cards first by rank, the
// others after by state. Sections without a card are left out.
export function sectionsByTurn(
    prs: readonly ReviewPr[],
    cards: Record<number, CardState>,
    sort: ReviewsSort,
    ranks?: Record<number, number>
): TurnSection[] {
    const precedence = (pr: ReviewPr) => CardStateKinds.indexOf(cards[pr.number]?.kind ?? "ready");
    const indexed = prs.map((pr, i) => ({ pr, i }));
    // Ranked before unranked, so the order stays a total one.
    const rankGap = (a: ReviewPr, b: ReviewPr) => {
        const ra = ranks?.[a.number] ?? Infinity;
        const rb = ranks?.[b.number] ?? Infinity;
        return ra === rb ? 0 : ra < rb ? -1 : 1;
    };
    const byState = (a: { pr: ReviewPr; i: number }, b: { pr: ReviewPr; i: number }) =>
        precedence(a.pr) - precedence(b.pr) || rankGap(a.pr, b.pr) || a.i - b.i;
    const compare =
        sort === "merge"
            ? (a: { pr: ReviewPr; i: number }, b: { pr: ReviewPr; i: number }) => {
                  const ra = ranks?.[a.pr.number];
                  const rb = ranks?.[b.pr.number];
                  if (ra != null && rb != null) {
                      return ra - rb;
                  }
                  if (ra != null) {
                      return -1;
                  }
                  if (rb != null) {
                      return 1;
                  }
                  return byState(a, b);
              }
            : byState;
    const sorted = [...indexed].sort(compare).map((x) => x.pr);
    return TurnOrder.map((turn) => ({
        turn,
        prs: sorted.filter((pr) => (cards[pr.number]?.turn ?? "yours") === turn),
    })).filter((s) => s.prs.length > 0);
}

// withTurnShown: the sections with turn's present, empty when no card is in it, at its place in TurnOrder. The merge
// queue's banner lives in "Agents on it" (#1123): the section shows while the queue does, cards or not.
export function withTurnShown(sections: TurnSection[], turn: CardTurn, shown: boolean): TurnSection[] {
    if (!shown || sections.some((s) => s.turn === turn)) {
        return sections;
    }
    const place = TurnOrder.indexOf(turn);
    const rtn = sections.filter((s) => TurnOrder.indexOf(s.turn) < place);
    return [...rtn, { turn, prs: [] }, ...sections.slice(rtn.length)];
}

// The cards a keyboard walks: those of the open sections, in their shown order.
export function sectionRows(sections: readonly TurnSection[], folded: Partial<Record<CardTurn, boolean>>): ReviewPr[] {
    return sections.filter((s) => !folded?.[s.turn]).flatMap((s) => s.prs);
}

// The section a PR's card is in, to unfold it when another surface asks for that PR.
export function sectionOf(sections: readonly TurnSection[], number: number): CardTurn {
    return sections.find((s) => s.prs.some((pr) => pr.number === number))?.turn ?? null;
}

// ---- Upcoming (FR-REV-022 AC11) ----

export type UpcomingItem = { branch: UpcomingBranch; agent: AgentBarFacts };

export type UpcomingEntry =
    | { kind: "branch"; key: string; item: UpcomingItem; waiting: boolean }
    | {
          kind: "session";
          key: string;
          parentBlockId: string;
          parentName: string;
          items: UpcomingItem[];
          waiting: boolean;
      };

// The agent of an entry waits for the developer: a panel agent waiting.
function itemWaits(agent: AgentBarFacts): boolean {
    return agent?.kind === "panel" && agent.state === "waiting";
}

// upcomingEntries: the upcoming branches as cards. Branches whose agent runs inside another session (a sub-agent, or
// a background agent with a known parent) group under that session when it holds two or more; the entries waiting
// for the developer come first, then those with an agent, then the others, each in wavesrv's order. parentWaits says
// whether a session's own panel waits for the developer.
export function upcomingEntries(
    rows: readonly UpcomingBranch[],
    agentOf: (branch: string) => AgentBarFacts,
    parentWaits?: (blockId: string) => boolean
): UpcomingEntry[] {
    const items = rows.map((branch) => ({ branch, agent: agentOf(branch.branch) }));
    const parentOf = (agent: AgentBarFacts) =>
        agent != null && agent.kind !== "panel" && agent.parentBlockId ? agent.parentBlockId : "";
    const counts = new Map<string, number>();
    for (const item of items) {
        const parent = parentOf(item.agent);
        if (parent) {
            counts.set(parent, (counts.get(parent) ?? 0) + 1);
        }
    }
    const entries: UpcomingEntry[] = [];
    const sessions = new Map<string, Extract<UpcomingEntry, { kind: "session" }>>();
    for (const item of items) {
        const parent = parentOf(item.agent);
        if (parent && (counts.get(parent) ?? 0) >= 2) {
            let session = sessions.get(parent);
            if (session == null) {
                session = {
                    kind: "session",
                    key: `session:${parent}`,
                    parentBlockId: parent,
                    parentName: item.agent.parentName ?? "",
                    items: [],
                    waiting: parentWaits?.(parent) ?? false,
                };
                sessions.set(parent, session);
                entries.push(session);
            }
            session.items.push(item);
            if (!session.parentName && item.agent.parentName) {
                session.parentName = item.agent.parentName;
            }
            continue;
        }
        entries.push({ kind: "branch", key: item.branch.branch, item, waiting: itemWaits(item.agent) });
    }
    const rank = (e: UpcomingEntry) => (e.waiting ? 0 : e.kind === "session" || e.item.agent != null ? 1 : 2);
    return entries
        .map((entry, i) => ({ entry, i }))
        .sort((a, b) => rank(a.entry) - rank(b.entry) || a.i - b.i)
        .map((x) => x.entry);
}

export function upcomingWaitingCount(entries: readonly UpcomingEntry[]): number {
    return entries.filter((e) => e.waiting).length;
}

// ---- Recently merged (FR-REV-027 AC6 to AC8) ----

// must match NextKey, UnknownKey and the tag keys of merged-history-model.ts: a group opens the history there.
export type MergedGroup = { key: string; kind: "next" | "tag" | "unknown"; tag?: string; prs: ReviewMergedPr[] };

// mergedGroups: the merged PRs by the version that ships them: the next version first, then each tag in the list's
// order (newest merge first), then the PRs git cannot place yet.
export function mergedGroups(merged: readonly ReviewMergedPr[]): MergedGroup[] {
    const next: MergedGroup = { key: "next", kind: "next", prs: [] };
    const unknown: MergedGroup = { key: "unknown", kind: "unknown", prs: [] };
    const tags = new Map<string, MergedGroup>();
    for (const pr of merged ?? []) {
        if (pr.ships === "tag" && pr.shipsin) {
            let group = tags.get(pr.shipsin);
            if (group == null) {
                group = { key: `tag:${pr.shipsin}`, kind: "tag", tag: pr.shipsin, prs: [] };
                tags.set(pr.shipsin, group);
            }
            group.prs.push(pr);
            continue;
        }
        if (pr.ships === "next" || pr.ships === "branch") {
            next.prs.push(pr);
            continue;
        }
        unknown.prs.push(pr);
    }
    return [next, ...tags.values(), unknown].filter((g) => g.prs.length > 0);
}

// A PR title without the ticket prefix the workflow puts on it ("[#1050] Terminal header…"): the row shows the
// ticket number already.
export function mergedTitle(pr: ReviewMergedPr): string {
    const title = pr.title ?? "";
    const stripped = title.replace(/^\s*\[#\d+\]\s*/, "");
    return stripped || title;
}

// Who a merged row names besides the agent: the developer is the account that merged it, so an author or a reviewer
// is named only when someone else. you: no agent signed it and the developer wrote it.
export type MergedWho = { agent?: string; model?: string; you?: boolean; author?: string; reviewer?: string };

export function mergedWho(pr: ReviewMergedPr, modelName: (model: string) => string): MergedWho {
    const me = (pr.mergedby ?? "").toLowerCase();
    const sig = pr.agents?.[0];
    const rtn: MergedWho = {};
    if (sig != null && (sig.firstname || sig.agent)) {
        rtn.agent = sig.firstname || sig.agent;
        rtn.model = modelName(sig.model ?? "") || sig.model || "";
    }
    const author = pr.author ?? "";
    if (author && me && author.toLowerCase() !== me) {
        rtn.author = author;
    } else if (rtn.agent == null && author) {
        rtn.you = true;
    }
    const reviewer = pr.reviewed?.name ?? "";
    if (reviewer && reviewer.toLowerCase() !== me && reviewer.toLowerCase() !== author.toLowerCase()) {
        rtn.reviewer = reviewer;
    }
    return rtn;
}
