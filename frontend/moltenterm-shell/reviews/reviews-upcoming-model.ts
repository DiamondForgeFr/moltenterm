// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's upcoming work and the agents on each branch (#712, FR-REV-022, DS-REV-015): wavesrv places the
// agents on branches (pkg/molten/mission/upcoming.go), the window adds what its agent-state store knows now (state,
// first name), so a bar turns from working to waiting at once. Kept apart from the components to be tested alone.

import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import { modelDisplayName } from "../companion/companion-proportion";
import { TFunction } from "../i18n/i18n";
import type { Phrase } from "../i18n/phrase";
import type { ServerText } from "../i18n/server-text";
import { dateLocale } from "../mission/time-format";
import type { ReviewsAnswer } from "./reviews-model";

// must match the names in pkg/molten/mission/upcoming.go
export const UpcomingCommand = "moltenmissionupcoming";

// must match UpcomingBranch in pkg/molten/mission/upcoming.go
export type UpcomingBranch = {
    branch: string;
    ticket: number;
    ahead: number;
    remote?: boolean;
    worktree?: string;
    commitat?: number;
    title?: string;
    url?: string;
    status?: string;
    // The branch's PR closed in the window (#1088), merged or not, and its commits after that PR's head (-1: unknown).
    afterpr?: number;
    afterstate?: "merged" | "closed";
    aftercount?: number;
};

// must match UpcomingLeftover in pkg/molten/mission/upcoming_done.go: a merged PR's branch holding nothing new.
export type UpcomingLeftover = {
    branch: string;
    ticket?: number;
    pr: number;
    title?: string;
    url?: string;
    mergedat?: string;
    worktree?: string;
    local?: boolean;
    remote?: boolean;
    commitat?: number;
    // #1121: closed = closed without merging, its content already in base; lock: the worktree's lock (ended: its
    // holder process ended; held: unknown holder, the cleanup keeps it); reviewtree, copies: what else the PR left.
    state?: "merged" | "closed";
    base?: string;
    lock?: "ended" | "held";
    lockpid?: number;
    reviewtree?: string;
    copies?: string[];
};

// must match BranchAgent in pkg/molten/mission/upcoming.go
export type BranchAgent = {
    branch: string;
    worktree: string;
    kind: "panel" | "background" | "subagent";
    blockid?: string;
    agent?: string;
    firstname?: string;
    started?: number;
    activeat?: number;
    parentblockid?: string;
    parentfirstname?: string;
    // A sub-agent's (#1035): its model, its task, its state; activeat is then its last write, or its end.
    model?: string;
    description?: string;
    state?: SubagentState;
};

// must match companion.SubagentRunning, SubagentQuiet and SubagentDone in pkg/molten/companion/topics.go
export type SubagentState = "running" | "quiet" | "done";

// must match UpcomingDraft in pkg/molten/mission/upcoming.go
export type UpcomingDraft = { branch: string; ticket?: number; status?: string; commitat?: number };

// must match UpcomingAnswer in pkg/molten/mission/upcoming.go
export type UpcomingAnswer = {
    dir: string;
    target?: string;
    branches: UpcomingBranch[];
    agents: BranchAgent[];
    drafts?: UpcomingDraft[];
    leftovers?: UpcomingLeftover[];
    error?: string;
    errortext?: ServerText;
    ticketserror?: string;
    at: number;
};

export type BarState = "working" | "waiting" | "done" | "idle" | "background";

// What the bar under a tile shows of the agent on the row's branch.
export type AgentBarFacts = {
    kind: "panel" | "background" | "subagent";
    blockId?: string;
    agent?: string;
    name: string;
    state: BarState;
    // What MoltenTerm says the agent does while it holds its state (#896): "fixing the CI of #12".
    held?: { text: ServerText; english: string };
    // Since when the agent is on it (a panel), or its last sign of activity (a background agent), in ms.
    since: number;
    parentBlockId?: string;
    parentName?: string;
    // A sub-agent's (#1035): what its own files say of it.
    agentName?: string;
    model?: string;
    description?: string;
    subState?: SubagentState;
    // When the agent's state last changed, and whether it is in error (#954: a task's agent stopped since the ask).
    stateSince?: number;
    errored?: boolean;
    // A task's agent whose terminal is still open but no longer on the task's branch (#1057).
    offBranch?: boolean;
    // The merge queue's agent on the PR it works on (#1128): its line says the queue's work and offers Go there, never
    // Stop (the banner stops the whole queue).
    batch?: boolean;
    work?: Phrase;
};

// The upcoming rows: a branch whose PR the Reviews list now shows leaves at once, without waiting for wavesrv.
export function upcomingRows(upcoming: UpcomingAnswer, reviews: ReviewsAnswer): UpcomingBranch[] {
    if (upcoming?.branches == null) {
        return [];
    }
    const withPr = new Set<string>();
    for (const pr of [...(reviews?.ready ?? []), ...(reviews?.drafts ?? [])]) {
        withPr.add(pr.branch);
    }
    return upcoming.branches.filter((b) => !withPr.has(b.branch));
}

// How long a future PR's entry asked by another surface stays marked (the PR rows' mark lasts as long).
export const UpcomingFocusMarkMs = 4000;

// The branch of a focus request (ReviewsFocus) this section answers: a future PR's, for this project, once listed.
export function upcomingFocusBranch(
    focus: { dir: string; number: number; branch?: string },
    dir: string,
    rows: UpcomingBranch[]
): string {
    if (focus == null || focus.dir !== dir || focus.number > 0 || !focus.branch) {
        return null;
    }
    return rows.some((row) => row.branch === focus.branch) ? focus.branch : null;
}

function barState(info: AgentStateInfo): BarState {
    switch (info?.state) {
        case "working":
        case "waiting":
        case "done":
            return info.state;
        case "error":
            return "waiting";
    }
    return "idle";
}

// branchAgent: the agent the bar under the branch's tile shows. A panel agent whose terminal the windows no longer
// know is gone (closed since wavesrv answered); the most urgent panel wins over a background one.
export function branchAgent(upcoming: UpcomingAnswer, states: AgentStatesData, branch: string): AgentBarFacts {
    return branchAgents(upcoming, states, branch)[0] ?? null;
}

const KindRank: Record<AgentBarFacts["kind"], number> = { panel: 2, subagent: 1, background: 0 };

// branchAgents (#1057): every agent on the branch, the one branchAgent picks first: panels by urgency, then
// sub-agents, then background agents, each kind in wavesrv's order. A card lists them all, each with its own state.
export function branchAgents(upcoming: UpcomingAnswer, states: AgentStatesData, branch: string): AgentBarFacts[] {
    if (upcoming?.agents == null || !branch) {
        return [];
    }
    const found: AgentBarFacts[] = [];
    for (const a of upcoming.agents) {
        if (a.branch !== branch) {
            continue;
        }
        if (a.kind === "subagent") {
            found.push(subagentFacts(a, states));
            continue;
        }
        if (a.kind === "background") {
            found.push({
                kind: "background",
                agent: a.agent,
                name: "",
                state: "background",
                since: a.activeat ?? 0,
                parentBlockId: a.parentblockid,
                parentName: states?.states?.[a.parentblockid]?.firstname || a.parentfirstname,
            });
            continue;
        }
        const facts = panelFacts(a.blockid, states?.states?.[a.blockid], a);
        if (facts != null) {
            found.push(facts);
        }
    }
    const rank = (f: AgentBarFacts) => KindRank[f.kind] * 10 + (f.kind === "panel" ? BarUrgency[f.state] : 0);
    return found
        .map((facts, i) => ({ facts, i }))
        .sort((x, y) => rank(y.facts) - rank(x.facts) || x.i - y.i)
        .map((x) => x.facts);
}

// panelFacts: a panel agent as its terminal's state says it; null when the windows no longer know the terminal.
// placed: wavesrv's placement on a branch, when it has one.
export function panelFacts(blockId: string, info: AgentStateInfo, placed?: BranchAgent): AgentBarFacts {
    if (info == null || !blockId) {
        return null;
    }
    const facts: AgentBarFacts = {
        kind: "panel",
        blockId,
        agent: info.agent || placed?.agent,
        name: (info.firstname || placed?.firstname || "").trim() || info.agentname || info.agent || placed?.agent || "",
        state: barState(info),
        since: placed != null ? (placed.started ?? 0) : (info.since ?? 0),
        stateSince: info.since ?? 0,
        errored: info.state === "error",
    };
    if (info.messagetext != null) {
        facts.held = { text: info.messagetext, english: info.message ?? "" };
    }
    return facts;
}

// The tools' own names, when the parent's state does not give one (codingAgentName, without its store).
const AgentNames: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

const SubagentBarStates: Record<SubagentState, BarState> = { running: "working", quiet: "idle", done: "done" };

// A sub-agent of a panel (#1035): named by its parent, its tool's and its model's names, its task; its own state.
function subagentFacts(a: BranchAgent, states: AgentStatesData): AgentBarFacts {
    const parent = states?.states?.[a.parentblockid];
    const subState: SubagentState = SubagentBarStates[a.state] != null ? a.state : "running";
    return {
        kind: "subagent",
        agent: a.agent || parent?.agent,
        agentName: parent?.agentname,
        name: "",
        state: SubagentBarStates[subState],
        since: a.activeat ?? 0,
        stateSince: a.activeat ?? 0,
        parentBlockId: a.parentblockid,
        parentName: (parent?.firstname || a.parentfirstname || "").trim(),
        model: a.model,
        description: a.description,
        subState,
    };
}

// What the bar says after a sub-agent's name: "Claude Code · Opus 5.5 · #1033 agent name in tabs".
export function subagentDetails(facts: AgentBarFacts): string {
    if (facts?.kind !== "subagent") {
        return "";
    }
    return [
        facts.agentName || AgentNames[facts.agent] || facts.agent,
        modelDisplayName(facts.model),
        (facts.description ?? "").trim(),
    ]
        .filter((s) => !!s)
        .join(" · ");
}

const BarUrgency: Record<BarState, number> = { waiting: 4, working: 3, done: 2, idle: 1, background: 0 };

// The board columns of the SaaSFoundry workflows (.saasfoundry.json → workflow statuses) by whose turn they are
// (#954): the agent's while it builds or tests, the developer's at the human gates. A Solo workflow has no Human
// Testing: its AI Testing drafts are the agent's, which mark them ready themselves.
const AgentTurnStatuses = new Set(["in progress", "ai drafting", "spawning", "ai testing"]);
const TestTurnStatuses = new Set(["human testing"]);
const ReviewTurnStatuses = new Set(["human review", "in review"]);

// A commit this recent on a draft's branch means someone, probably an agent started outside MoltenTerm, works on it.
export const DraftActiveMs = 30 * 60_000;

// What a draft expects of the developer, for its row's chip: the agent's turn, a test, marking it ready, or theirs to
// finish when nothing says an agent is on it.
export type DraftTurn = { owner: "agent" | "developer"; kind: "agent" | "test" | "ready" | "yours"; status?: string };

export function draftTurn(agent: AgentBarFacts, draft: UpcomingDraft, now: number): DraftTurn {
    const status = (draft?.status ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    if (agent != null || AgentTurnStatuses.has(status)) {
        return { owner: "agent", kind: "agent", status: draft?.status };
    }
    if (TestTurnStatuses.has(status)) {
        return { owner: "developer", kind: "test", status: draft?.status };
    }
    if (ReviewTurnStatuses.has(status)) {
        return { owner: "developer", kind: "ready", status: draft?.status };
    }
    if (draft?.commitat && now - draft.commitat < DraftActiveMs) {
        return { owner: "agent", kind: "agent" };
    }
    return { owner: "developer", kind: "yours", status: draft?.status };
}

const ClockFormats = new Map<string, Intl.DateTimeFormat>();

function clockFormat(): Intl.DateTimeFormat {
    const locale = dateLocale();
    let f = ClockFormats.get(locale);
    if (f == null) {
        f = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
        ClockFormats.set(locale, f);
    }
    return f;
}

// "12 min", "2 h 05", "3 d": how long, at minute granularity.
export function durationText(t: TFunction, ms: number): string {
    const minutes = Math.max(0, Math.floor(ms / 60_000));
    if (minutes < 1) {
        return t("reviewsAgents.duration.lessThanMinute");
    }
    if (minutes < 60) {
        return t("reviewsAgents.duration.minutes", { count: minutes });
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return t("reviewsAgents.duration.hours", { hours, minutes: String(minutes % 60).padStart(2, "0") });
    }
    return t("reviewsAgents.duration.days", { count: Math.floor(hours / 24) });
}

// When: the clock time today, the day and time before.
export function sinceText(since: number, now: number): string {
    const date = new Date(since);
    const clock = clockFormat().format(date);
    if (new Date(now).toDateString() === date.toDateString()) {
        return clock;
    }
    return `${new Intl.DateTimeFormat(dateLocale(), { day: "numeric", month: "short" }).format(date)} ${clock}`;
}

// The bar's time line: "for 12 min · since 20:41", or for a background agent "last change 3 min ago".
export function barTimeText(t: TFunction, facts: AgentBarFacts, now: number): string {
    if (facts == null || !facts.since) {
        return "";
    }
    const elapsed = durationText(t, now - facts.since);
    if (facts.kind === "subagent" && facts.subState === "done") {
        return t("reviewsAgents.subagent.finishedAgo", { duration: elapsed });
    }
    if (facts.kind === "background" || facts.kind === "subagent") {
        return t("reviewsAgents.lastChange", { duration: elapsed });
    }
    return t("reviewsAgents.forSince", { duration: elapsed, since: sinceText(facts.since, now) });
}

export function barStateText(t: TFunction, state: BarState): string {
    return t(`reviewsAgents.state.${state}`);
}

// "3 commits ahead", for the upcoming row.
// The board columns the SaaSFoundry workflows declare (.saasfoundry.json → workflow statuses), by their name in
// lower case with single spaces: the board writes "In progress" or "In Progress" (#727).
export const BoardStatusKeys: Record<string, string> = {
    backlog: "reviewsAgents.upcoming.boardStatus.backlog",
    ready: "reviewsAgents.upcoming.boardStatus.ready",
    "in progress": "reviewsAgents.upcoming.boardStatus.inProgress",
    "ai drafting": "reviewsAgents.upcoming.boardStatus.aiDrafting",
    "human review": "reviewsAgents.upcoming.boardStatus.humanReview",
    spawning: "reviewsAgents.upcoming.boardStatus.spawning",
    "ai testing": "reviewsAgents.upcoming.boardStatus.aiTesting",
    "human testing": "reviewsAgents.upcoming.boardStatus.humanTesting",
    "in review": "reviewsAgents.upcoming.boardStatus.inReview",
    done: "reviewsAgents.upcoming.boardStatus.done",
};

// A board status in the user's language; a column the workflow does not declare is shown as the board names it.
export function boardStatusText(t: TFunction, status: string): string {
    const name = (status ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(BoardStatusKeys, name)) {
        return status;
    }
    return t(BoardStatusKeys[name]);
}

// What an upcoming branch says of its PR closed in the window (#1088): the follow-up commits after a merged PR, or a PR
// closed without merging. "" when the branch had none.
export function afterPrText(t: TFunction, branch: UpcomingBranch): string {
    const number = branch?.afterpr;
    if (!(number > 0)) {
        return "";
    }
    const count = branch.aftercount ?? 0;
    const state = branch.afterstate === "closed" ? "closed" : "merged";
    if (count > 0) {
        return t(`reviewsAgents.upcoming.after.${state}${count === 1 ? "One" : ""}`, { number, count });
    }
    if (count < 0) {
        return t(`reviewsAgents.upcoming.after.${state}Unknown`, { number });
    }
    return state === "closed" ? t("reviewsAgents.upcoming.after.closedNothing", { number }) : "";
}

export function aheadText(t: TFunction, ahead: number): string {
    if (!ahead) {
        return t("reviewsAgents.upcoming.noCommit");
    }
    if (ahead === 1) {
        return t("reviewsAgents.upcoming.aheadOne");
    }
    return t("reviewsAgents.upcoming.ahead", { count: ahead });
}
