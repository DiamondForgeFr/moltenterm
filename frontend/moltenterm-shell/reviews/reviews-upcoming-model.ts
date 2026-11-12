// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Reviews view's upcoming work and the agents on each branch (#712, FR-REV-022, DS-REV-015): wavesrv places the
// agents on branches (pkg/molten/mission/upcoming.go), the window adds what its agent-state store knows now (state,
// first name), so a bar turns from working to waiting at once. Kept apart from the components to be tested alone.

import { agentFactsLine, type AgentFacts } from "../agent-facts";
import { agentDisplayName, currentFeatureMatrix } from "../agent-info/agent-features-model";
import { agentToolName, type AgentStateInfo, type AgentStatesData } from "../agent-state-model";
import { branchTicketNumber } from "../agent-work-model";
import { TFunction } from "../i18n/i18n";
import { phrase, serverPhrase, type Phrase } from "../i18n/phrase";
import type { ServerText } from "../i18n/server-text";
import { dateLocale } from "../mission/time-format";
import type { LeftoverOwner } from "./reviews-leftover-owner-model";
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
    lock?: "ended" | "held" | "live";
    lockpid?: number;
    // #1143: live: a running process holds the lock; owner names it (only it removes the worktree).
    owner?: LeftoverOwner;
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
    // A panel's time on the branch (#1841: never before it entered the worktree), a sub-agent's start.
    started?: number;
    // #1841: a panel whose session only passed through the worktree (it wrote nothing there since it came).
    visiting?: boolean;
    activeat?: number;
    parentblockid?: string;
    parentfirstname?: string;
    // A sub-agent's (#1035): its model, its task, its state; activeat is then its last write, or its end. effort
    // (#1848) is its effort level; a signed background agent has the model and effort it signed.
    model?: string;
    effort?: string;
    description?: string;
    state?: SubagentState;
    // #1955: a sub-agent's id in its CLI, which its lead continues it by.
    agentid?: string;
    // #1603: a background agent named by its work's signature; agentname is its CLI as signed, blockid the signer's
    // session while a panel still runs it.
    signed?: boolean;
    agentname?: string;
};

// must match companion.SubagentRunning, SubagentQuiet and SubagentDone in pkg/molten/companion/topics.go
export type SubagentState = "running" | "quiet" | "done";

// must match UpcomingDraft in pkg/molten/mission/upcoming.go
export type UpcomingDraft = { branch: string; ticket?: number; status?: string; commitat?: number };

// must match UpcomingPrBranch in pkg/molten/mission/upcoming_prbranches.go: another branch of an open PR's ticket.
export type UpcomingPrBranch = {
    branch: string;
    ticket: number;
    pr: number;
    ahead: number;
    remote?: boolean;
    worktree?: string;
};

// must match UpcomingAnswer in pkg/molten/mission/upcoming.go
export type UpcomingAnswer = {
    dir: string;
    target?: string;
    branches: UpcomingBranch[];
    agents: BranchAgent[];
    drafts?: UpcomingDraft[];
    leftovers?: UpcomingLeftover[];
    prbranches?: UpcomingPrBranch[];
    // Whether the project's workflow has a Human Testing column (#1172); unset when it declares no statuses.
    humantesting?: "yes" | "no";
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
    // The CLI, model and effort every agent line says in that order (#1848): a panel's are those its terminal's run
    // reports, a sub-agent's what its own files say of it (#1035), a signed background agent's its signature's.
    // modelName: the model as the agent itself names it, when it gave no id.
    agentName?: string;
    model?: string;
    modelName?: string;
    effort?: string;
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
    // A background agent named by its signature (#1603); agentName is then its CLI as signed.
    signed?: boolean;
    // A panel on the branch whose only work is sub-agents on other tickets (#1796): idle here, its line says where it
    // is busy; ticket 0 when the sub-agents' branch names none.
    elsewhere?: { ticket: number };
    // A panel whose session only passed through the branch's worktree (#1841): idle here, its line says so.
    visiting?: boolean;
    // The stop this panel made for a decision was settled by its lead or the developer (#1876): it is idle, and this
    // says who settled it and why. by is "" for the developer.
    settled?: { by: string; note: string; at: number };
};

// The upcoming rows: a branch whose PR the Reviews list now shows leaves at once, without waiting for wavesrv; so does
// any branch of a ticket the list shows a PR for (#1172: one card per ticket, the PR's).
export function upcomingRows(upcoming: UpcomingAnswer, reviews: ReviewsAnswer): UpcomingBranch[] {
    if (upcoming?.branches == null) {
        return [];
    }
    const withPr = new Set<string>();
    const tickets = new Set<number>();
    for (const pr of [...(reviews?.ready ?? []), ...(reviews?.drafts ?? [])]) {
        withPr.add(pr.branch);
        if (pr.ticket > 0) {
            tickets.add(pr.ticket);
        }
    }
    return upcoming.branches.filter((b) => !withPr.has(b.branch) && !(b.ticket > 0 && tickets.has(b.ticket)));
}

// prOtherBranches (#1172): the other branches of a PR's ticket, listed on its card: those wavesrv placed on the PR,
// and those it still read as upcoming before the list showed the PR.
export function prOtherBranches(
    upcoming: UpcomingAnswer,
    pr: { number: number; branch: string; ticket?: number }
): UpcomingPrBranch[] {
    if (upcoming == null || pr == null) {
        return [];
    }
    const rtn: UpcomingPrBranch[] = (upcoming.prbranches ?? []).filter(
        (b) => b.pr === pr.number && b.branch !== pr.branch
    );
    if (pr.ticket > 0) {
        for (const b of upcoming.branches ?? []) {
            if (b.ticket === pr.ticket && b.branch !== pr.branch && !rtn.some((o) => o.branch === b.branch)) {
                rtn.push({
                    branch: b.branch,
                    ticket: b.ticket,
                    pr: pr.number,
                    ahead: b.ahead,
                    remote: b.remote,
                    worktree: b.worktree,
                });
            }
        }
    }
    return rtn;
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
// ticket: the branch's own ticket, when the caller knows it (a PR's), else read from the branch name; pr: its PR's
// number, when it has one. A running sub-agent placed on no branch (a read-only one, without a worktree: #1825) is the
// branch's when its task names the ticket or the PR.
export function branchAgents(
    upcoming: UpcomingAnswer,
    states: AgentStatesData,
    branch: string,
    ticket?: number,
    pr?: number
): AgentBarFacts[] {
    if (upcoming?.agents == null || !branch) {
        return [];
    }
    const own = { ticket: ticket || branchTicketNumber(branch), pr: pr ?? 0 };
    const found: AgentBarFacts[] = [];
    for (const a of upcoming.agents) {
        if (a.kind === "subagent" && !a.branch && a.state !== "done" && namesWork(a.description, own)) {
            found.push(subagentFacts(a, states));
            continue;
        }
        if (a.branch !== branch) {
            continue;
        }
        if (a.kind === "subagent") {
            found.push(subagentFacts(a, states));
            continue;
        }
        if (a.kind === "background") {
            const signedName = a.signed ? (a.firstname ?? "").trim() : "";
            found.push({
                kind: "background",
                agent: a.agent,
                name: signedName,
                state: "background",
                since: a.activeat ?? 0,
                parentBlockId: a.parentblockid,
                parentName: states?.states?.[a.parentblockid]?.firstname || a.parentfirstname,
                signed: a.signed,
                agentName: a.signed ? a.agentname : undefined,
                model: a.signed ? a.model : undefined,
                effort: a.signed ? a.effort : undefined,
                // The signer's session, while the windows still know its terminal.
                blockId: a.signed && a.blockid && states?.states?.[a.blockid] != null ? a.blockid : undefined,
            });
            continue;
        }
        const info = states?.states?.[a.blockid];
        const facts = panelFacts(a.blockid, info, a);
        if (facts == null) {
            continue;
        }
        const elsewhere = busyElsewhere(upcoming, info, branch, own.ticket, own.pr);
        if (elsewhere != null) {
            found.push({ ...facts, state: "idle", held: undefined, elsewhere });
        } else if (a.visiting) {
            found.push({ ...facts, state: "idle", held: undefined, visiting: true });
        } else {
            found.push(facts);
        }
    }
    const rank = (f: AgentBarFacts) => KindRank[f.kind] * 10 + (f.kind === "panel" ? BarUrgency[f.state] : 0);
    return found
        .map((facts, i) => ({ facts, i }))
        .sort((x, y) => rank(y.facts) - rank(x.facts) || x.i - y.i)
        .map((x) => x.facts);
}

// busyElsewhere (#1796, FR-REV-022): a panel on the branch whose main session is idle and whose working state is only
// its sub-agents' (background) works on this branch only if one of them does. It is busy elsewhere when none of its
// running sub-agents is placed on this branch or names this ticket or this PR in its task (#1825), and each is placed
// in another branch's worktree or names other work. A sub-agent wavesrv does not list, or one placed on no branch
// whose task names nothing, leaves the doubt to the branch: null.
export function busyElsewhere(
    upcoming: UpcomingAnswer,
    info: AgentStateInfo,
    branch: string,
    ticket: number,
    pr?: number
): { ticket: number } {
    if (!info?.background || info.state !== "working" || !((info.subagents ?? 0) > 0)) {
        return null;
    }
    const subs = (upcoming?.agents ?? []).filter(
        (a) => a.kind === "subagent" && a.parentblockid === info.blockid && a.state !== "done"
    );
    if (subs.length < info.subagents) {
        return null;
    }
    const own = { ticket, pr: pr ?? 0 };
    if (subs.some((a) => a.branch === branch || namesWork(a.description, own))) {
        return null;
    }
    if (subs.some((a) => !a.branch && workNamed(a.description) === 0)) {
        return null;
    }
    return { ticket: branchTicketNumber(subs[0].branch) || workNamed(subs[0].description) };
}

// namesWork: a sub-agent's task names the ticket ("#1821") or the PR ("PR #1824", "#1824", "PR 1824").
function namesWork(text: string, own: { ticket: number; pr: number }): boolean {
    return [own.ticket, own.pr].some((n) => n > 0 && new RegExp(`(?:#|\\bPR\\s*#?)${n}(?!\\d)`, "i").test(text ?? ""));
}

// The first ticket or PR number a sub-agent's task names, 0 when none.
function workNamed(text: string): number {
    const m = /(?:#|\bPR\s*#?)(\d+)/i.exec(text ?? "");
    return m ? Number(m[1]) : 0;
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
        agentName: agentToolName(info) || toolName(placed?.agent),
        model: info.model,
        modelName: info.modelname,
        effort: info.effort,
    };
    if (info.messagetext != null) {
        facts.held = { text: info.messagetext, english: info.message ?? "" };
    }
    if (info.settled != null) {
        facts.settled = { by: info.settled.by ?? "", note: info.settled.note ?? "", at: info.settled.at };
    }
    return facts;
}

// The tools' own names, when the parent's state does not give one: their rows of the compatibility matrix (FR-AGC-003).
function toolName(agent: string): string {
    return agent ? agentDisplayName(currentFeatureMatrix(), agent) : "";
}

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
        effort: a.effort,
        description: a.description,
        subState,
    };
}

// agentFacts: the CLI, model and effort an agent line says after its name, in that order (#1848), each only when
// known; a signed background agent's (#1603) come from its signature, as data, never in a sentence. A panel named by
// its CLI for want of a first name does not say it twice.
export function agentFacts(facts: AgentBarFacts): AgentFacts {
    if (facts == null || (facts.kind === "background" && !facts.signed)) {
        return {};
    }
    const cli = facts.agentName || toolName(facts.agent);
    return {
        cli: facts.kind === "panel" && cli.toLowerCase() === (facts.name ?? "").trim().toLowerCase() ? "" : cli,
        model: facts.model,
        modelName: facts.modelName,
        effort: facts.effort,
    };
}

// What the bar says after an agent's name: "Codex · gpt-5.5 · high", and a sub-agent's task after them:
// "Claude Code · Opus 5.5 · high · #1033 agent name in tabs".
export function agentDetails(facts: AgentBarFacts): string {
    return agentFactsLine(agentFacts(facts), facts?.kind === "subagent" ? facts.description : "");
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
// finish when nothing says an agent is on it. workflow: the agent's only because the workflow has no Human Testing
// (#1172), nothing else saying so.
export type DraftTurn = {
    owner: "agent" | "developer";
    kind: "agent" | "test" | "ready" | "yours";
    status?: string;
    workflow?: boolean;
};

export function draftTurn(
    agent: AgentBarFacts,
    draft: UpcomingDraft,
    now: number,
    humanTesting?: UpcomingAnswer["humantesting"]
): DraftTurn {
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
    // #1172: in a workflow without Human Testing (SaaSFoundry Solo) a draft is the agent's until In Review; an unknown
    // column (a token without the board's scope, a ticket off the board) does not make it the developer's.
    if (humanTesting === "no") {
        return { owner: "agent", kind: "agent", status: draft?.status, workflow: true };
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
    // A lead only passing through the branch has no time on it (#1841).
    if (facts == null || !facts.since || facts.visiting) {
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

// barPlaceText: what a panel's line says instead of its state when its state is not work on this branch: a lead busy
// on another ticket (#1796), one only passing through the branch's worktree (#1841). "" otherwise.
export function barPlaceText(t: TFunction, facts: AgentBarFacts): string {
    if (facts?.elsewhere != null) {
        return facts.elsewhere.ticket > 0
            ? t("reviewsAgents.busyOn", { number: facts.elsewhere.ticket })
            : t("reviewsAgents.busyElsewhere");
    }
    if (facts?.visiting) {
        return t("reviewsAgents.visiting");
    }
    return "";
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

// stoppedWithoutPr (#2270, FR-REV-022 AC23): the delegated agent of an Upcoming branch (which has no PR) is a sub-agent
// that finished or went quiet: nothing works on the branch any more. The states are those wavesrv already reads (AC9).
export function stoppedWithoutPr(agent: AgentBarFacts): boolean {
    return agent?.kind === "subagent" && (agent.subState === "done" || agent.subState === "quiet");
}

// must match RestartResult in pkg/molten/review/restart.go (the fields Resume reads)
export type UpcomingResumeResult = {
    status: string;
    reason?: string;
    firstname?: string;
    agentname?: string;
    message?: string;
    messagetext?: ServerText;
};

// upcomingResumeOutcome: the card's line for what wavesrv answered to Resume (#2270).
export function upcomingResumeOutcome(result: UpcomingResumeResult, error?: Phrase): Phrase {
    if (error != null) {
        return phrase("reviewsAgents.upcoming.resume.failed", { message: error });
    }
    if (result == null) {
        return null;
    }
    const name = result.firstname || result.agentname || "";
    const vars = { name };
    switch (result.status) {
        case "sent":
            return phrase("reviewsAgents.upcoming.resume.sent", vars);
        case "typed":
            return phrase("reviewsAgents.upcoming.resume.typed", vars);
        case "queued":
            return phrase("reviewsAgents.upcoming.resume.queued", vars);
        case "busy":
            if (result.reason === "alreadyhanded") {
                return phrase(
                    name ? "reviewsAgents.upcoming.resume.already" : "reviewsAgents.upcoming.resume.alreadyAnon",
                    vars
                );
            }
            return phrase(
                name ? "reviewsAgents.upcoming.resume.working" : "reviewsAgents.upcoming.resume.workingAnon",
                vars
            );
    }
    switch (result.reason) {
        case "leadnotrunning":
            return phrase(
                name ? "reviewsAgents.upcoming.resume.leadGone" : "reviewsAgents.upcoming.resume.nothing",
                vars
            );
        case "nothingtoresume":
            return phrase("reviewsAgents.upcoming.resume.nothing");
    }
    return phrase("reviewsAgents.upcoming.resume.failed", {
        message: serverPhrase(result.messagetext, result.message ?? ""),
    });
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
