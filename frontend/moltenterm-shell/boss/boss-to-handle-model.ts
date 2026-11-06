// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The card's To handle tab (FR-BOSS-003, DS-BOSS-002): one row per thing the developer has to do, each with its own
// actions. The rows are read from the models that already hold each fact (the agent states, the notifications, the pull
// requests of the Integration panel), so nothing here is a second source of truth: a row leaves when the fact it shows
// is gone. A question answered by its notification's buttons is one row with its agent, not two. Pure, so the rules are
// tested without a window.

import {
    AgentHandoffDecision,
    AgentHandoffNotificationKeyPrefix,
    PendingHandoff,
    PendingHandoffBrief,
} from "../agent-handoff-types";
import { agentCallName, AgentStateInfo, agentStateLabel, AgentStatesData } from "../agent-state-model";
import { t } from "../i18n/i18n";
import { checkNeedsAnswer } from "../notification-attention";
import { badgeCount } from "../notification-rules";
import {
    ClickActionId,
    MoltentermNotification,
    NotificationAction,
    notificationMessage,
    notificationTitle,
    visibleActions,
} from "../notifications-model";
import {
    checkNames,
    checksOf,
    mergeableNow,
    ReadiedPrs,
    ReviewPr,
    ReviewsAnswer,
    splitReviews,
} from "../reviews/reviews-model";
import { DurableSession } from "../sessions/sessions-model";
import { workspaceShownName } from "../workspace-default-name";
import type { Badge, PeekWaitingRow } from "./boss-overview";
import { attentionAgents } from "./boss-overview";

export type ToHandleTone = "error" | "waiting" | "success";

// A line of text: a key with its variables (translated when shown), or text the source wrote itself.
export type TextRef = { key?: string; vars?: Record<string, string | number>; text?: string };

// What a button does: each reaches a door the app already has (the agent's pane, the Integration panel, the
// notification's own buttons, the PR page).
export type ToHandleRun =
    | { kind: "goto"; sessionId: string }
    | { kind: "integration"; dir: string; number: number }
    | { kind: "rerun"; dir: string; number: number }
    | { kind: "external"; url: string }
    | { kind: "answer"; entry: MoltentermNotification; action: NotificationAction }
    // A hand-off request's answer: the route the request's notification answers through (FR-BOSS-005).
    | { kind: "handoff"; requestid: string; decision: AgentHandoffDecision }
    // Shows or hides the full brief in the row; nothing leaves the window.
    | { kind: "brief" }
    | { kind: "open"; entry: MoltentermNotification }
    // The developer did what a "go there and do it" notification asked: its situation closes (#1938).
    | { kind: "done"; entry: MoltentermNotification }
    | { kind: "later" };

export type ToHandleAction = {
    id: string;
    // The one primary action of the row, in the orange style.
    primary: boolean;
    // The label of every button but a notification's own, which carries its label.
    labelKey?: string;
    labelVars?: Record<string, string | number>;
    disabled: boolean;
    run: ToHandleRun;
};

// A file or a link the sender attached: what the row names and the brief lists.
export type HandoffAttachment = { name: string; detail: string };

// A request to hand work from one agent to another (FR-BOSS-005, #1891). Names and places are as wavesrv gave them,
// translated where they are shown: "" for a terminal that has no name, a workspace that has none.
export type HandoffRow = {
    requestid: string;
    from: string;
    to: string;
    fromPlace: string;
    toPlace: string;
    // One line of the goal.
    goal: string;
    files: HandoffAttachment[];
    links: HandoffAttachment[];
    // What the receiver would get, in full: "Read the brief".
    brief: PendingHandoffBrief;
};

export type ToHandleItem = {
    key: string;
    tone: ToHandleTone;
    // The notification the row is about: its title is the row's name when name is empty, and its message is the line
    // when lineFromNotice is set. Read when shown, so the language follows the app.
    notice: MoltentermNotification;
    lineFromNotice: boolean;
    name: string;
    line: TextRef;
    // The workspace of an agent, the project folder of a pull request, "" when none.
    place: string;
    // When it started waiting (Unix ms), 0 when unknown: the oldest waits come first within a rank.
    since: number;
    rank: number;
    // A "go there and do it" notification the developer has read (went there, or saw it in its pane): still listed until
    // it resolves or is marked done, drawn as seen, and no longer counted by the badge (#1938).
    seen: boolean;
    actions: ToHandleAction[];
    // Set on the rows of the "Mise en relation" group: the card draws them apart, with what the receiver would see.
    handoff?: HandoffRow;
};

export type InfoItem = { key: string; name: string; place: string; line: TextRef };

export type ToHandleList = {
    items: ToHandleItem[];
    info: InfoItem[];
    // Items set aside with Later, back at the next opening of the card.
    parked: number;
    // Their keys: a row that comes back from Later is not news.
    parkedKeys?: string[];
};

export type ToHandleInput = {
    states: AgentStatesData;
    // The notifications the developer sees (not archived, not filtered out by the preferences).
    notifications: MoltentermNotification[];
    answers: Record<string, ReviewsAnswer>;
    readied: ReadiedPrs;
    sessions: DurableSession[];
    // The keys of the items set aside with Later.
    parked: Record<string, boolean>;
    // The hand-off requests wavesrv holds for the developer (#1926), none until a first reading is in.
    handoffs?: PendingHandoff[];
};

// The rank of a row: errors first (a stopped agent, a failing CI), then what waits for an answer, then what is ready.
const RankError = 0;
const RankWait = 1;
const RankReady = 2;

export function lastSegment(path: string): string {
    const parts = (path ?? "").split(/[/\\]+/).filter((p) => p !== "");
    return parts[parts.length - 1] ?? "";
}

// The buttons a notification offers, its own labels and order, without the click on the notification itself.
export function answerButtons(entry: MoltentermNotification): NotificationAction[] {
    return visibleActions(entry).filter((a) => a.id !== ClickActionId);
}

// The newest open notification that asks the agent's block something (a question, a permission, a prompt for Enter). A
// notification a row already stands for is not the agent's question: a hand-off request's is keyed to the block of the
// agent that asked.
function newestNoticeOf(
    notifications: MoltentermNotification[],
    blockid: string,
    consumed: Set<string>
): MoltentermNotification {
    let newest: MoltentermNotification = null;
    for (const entry of notifications) {
        if (entry.blockid !== blockid || consumed.has(entry.id) || !checkNeedsAnswer(entry)) {
            continue;
        }
        if (newest == null || (entry.updated ?? entry.time) > (newest.updated ?? newest.time)) {
            newest = entry;
        }
    }
    return newest;
}

function answerActions(entry: MoltentermNotification): ToHandleAction[] {
    return answerButtons(entry).map((action) => ({
        id: `answer:${action.id}`,
        primary: false,
        disabled: false,
        run: { kind: "answer", entry, action },
    }));
}

function laterAction(): ToHandleAction {
    return { id: "later", primary: false, labelKey: "boss.todo.later", disabled: false, run: { kind: "later" } };
}

function doneAction(entry: MoltentermNotification): ToHandleAction {
    return { id: "done", primary: false, labelKey: "boss.todo.done", disabled: false, run: { kind: "done", entry } };
}

// A notification whose buttons only take the developer somewhere (a typed prompt waiting for Enter, #1938): nothing
// in it answers it, so the developer goes there, does it, and says so with Done. A question its buttons answer is not.
export function checkGoThere(entry: MoltentermNotification): boolean {
    return answerButtons(entry).every((action) => action.kind === "open");
}

// The first action of a row is its primary one: the answer a question offers first, else the way there.
function markPrimary(actions: ToHandleAction[]): ToHandleAction[] {
    return actions.map((action, i) => ({ ...action, primary: i === 0 }));
}

function sessionOf(sessions: DurableSession[], blockid: string): DurableSession {
    return (sessions ?? []).find((s) => s.blockid === blockid) ?? null;
}

function sinceOf(ms: number): number {
    return ms != null && Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function prSince(pr: ReviewPr): number {
    const ms = Date.parse(pr.updatedat ?? "");
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

// The row of an agent that waits or stopped on an error. A question its notification asks is answered in the row, by
// the same buttons, so the notification is consumed here and does not come again as a row of its own.
function agentItem(info: AgentStateInfo, input: ToHandleInput, consumed: Set<string>): ToHandleItem {
    const notice = newestNoticeOf(input.notifications, info.blockid, consumed);
    if (notice != null) {
        consumed.add(notice.id);
    }
    const session = sessionOf(input.sessions, info.blockid);
    const name = agentCallName(info);
    const failed = info.state === "error";
    const goTo: ToHandleAction = {
        id: "goto",
        primary: false,
        labelKey: "boss.todo.goTo",
        labelVars: { name },
        disabled: !session?.id,
        run: { kind: "goto", sessionId: session?.id ?? "" },
    };
    return {
        key: `agent:${info.blockid}`,
        tone: failed ? "error" : "waiting",
        notice,
        lineFromNotice: notice != null,
        name,
        line: failed
            ? { key: "boss.todo.agentError", vars: { name } }
            : { key: "boss.todo.agentWaiting", vars: { name } },
        place: workspaceShownName(session?.workspacename ?? "", t),
        since: sinceOf(info.since),
        rank: failed ? RankError : RankWait,
        seen: false,
        actions: markPrimary([...(notice != null ? answerActions(notice) : []), goTo, laterAction()]),
    };
}

// The row of a notification that needs an answer and is no agent's question. One that only takes the developer
// somewhere offers Done next to Later, and counts as seen once read: going there from its button reads it.
function noticeItem(entry: MoltentermNotification): ToHandleItem {
    const answers = answerActions(entry);
    const goThere = checkGoThere(entry);
    const open: ToHandleAction = {
        id: "open",
        primary: false,
        labelKey: "boss.todo.open",
        disabled: false,
        run: { kind: "open", entry },
    };
    return {
        key: `notif:${entry.id}`,
        tone: entry.kind === "error" ? "error" : "waiting",
        notice: entry,
        lineFromNotice: true,
        name: "",
        line: {},
        place: "",
        since: sinceOf(entry.updated ?? entry.time),
        rank: entry.kind === "error" ? RankError : RankWait,
        seen: goThere && !!entry.read,
        actions: markPrimary([
            ...answers,
            ...(answers.length === 0 ? [open] : []),
            ...(goThere ? [doneAction(entry)] : []),
            laterAction(),
        ]),
    };
}

// The rows of a project's pull requests the developer waits on: a failing CI, or a PR ready to merge.
function prItems(answer: ReviewsAnswer, readied: ReadiedPrs): ToHandleItem[] {
    const rtn: ToHandleItem[] = [];
    const place = lastSegment(answer.dir);
    for (const pr of splitReviews(answer, readied).ready) {
        if (pr.ci?.state === "failure") {
            rtn.push(failedCiItem(answer.dir, pr, place));
            continue;
        }
        if (mergeableNow(pr)) {
            rtn.push(readyItem(answer.dir, pr, place));
        }
    }
    return rtn;
}

function failedCiItem(dir: string, pr: ReviewPr, place: string): ToHandleItem {
    const checks = checkNames(checksOf(pr.ci, "failure"));
    return {
        key: `ci:${dir}:${pr.number}`,
        tone: "error",
        notice: null,
        lineFromNotice: false,
        name: `#${pr.number}`,
        line: { key: "boss.todo.ciFailed", vars: { checks } },
        place,
        since: prSince(pr),
        rank: RankError,
        seen: false,
        actions: markPrimary([
            {
                id: "failure",
                primary: false,
                labelKey: "boss.todo.seeFailure",
                disabled: false,
                run: { kind: "integration", dir, number: pr.number },
            },
            {
                id: "rerun",
                primary: false,
                labelKey: "boss.todo.rerunCi",
                disabled: false,
                run: { kind: "rerun", dir, number: pr.number },
            },
            laterAction(),
        ]),
    };
}

function readyItem(dir: string, pr: ReviewPr, place: string): ToHandleItem {
    return {
        key: `ready:${dir}:${pr.number}`,
        tone: "success",
        notice: null,
        lineFromNotice: false,
        name: `#${pr.number}`,
        line: { text: pr.title ?? "" },
        place,
        since: prSince(pr),
        rank: RankReady,
        seen: false,
        actions: markPrimary([
            {
                id: "integration",
                primary: false,
                labelKey: "boss.todo.openIntegration",
                disabled: false,
                run: { kind: "integration", dir, number: pr.number },
            },
            {
                id: "pr",
                primary: false,
                labelKey: "boss.todo.seePr",
                disabled: !pr.url,
                run: { kind: "external", url: pr.url ?? "" },
            },
            laterAction(),
        ]),
    };
}

function handoffAction(requestid: string, id: string, decision: AgentHandoffDecision): ToHandleAction {
    return {
        id,
        primary: false,
        labelKey: `boss.todo.handoff.${id}`,
        disabled: false,
        run: { kind: "handoff", requestid, decision },
    };
}

// The row of a request to hand work from one agent to another. It answers through the route the request's notification
// answers through, so that notification is consumed here and does not come again as a row of its own. Refuse is the
// notification's Block: the pair stays refused until the developer lifts it from the terminal's connections menu.
function handoffItem(
    request: PendingHandoff,
    notifications: MoltentermNotification[],
    consumed: Set<string>
): ToHandleItem {
    const key = AgentHandoffNotificationKeyPrefix + request.requestid;
    for (const entry of notifications) {
        if (entry.key === key) {
            consumed.add(entry.id);
        }
    }
    const brief: PendingHandoffBrief = request.brief ?? { goal: request.goal ?? "" };
    return {
        key: `handoff:${request.requestid}`,
        tone: "waiting",
        notice: null,
        lineFromNotice: false,
        name: request.from ?? "",
        line: { text: request.goal ?? "" },
        place: "",
        since: sinceOf(request.createdat),
        rank: RankWait,
        seen: false,
        actions: markPrimary([
            handoffAction(request.requestid, "once", "once"),
            handoffAction(request.requestid, "always", "always"),
            handoffAction(request.requestid, "refuse", "block"),
            {
                id: "brief",
                primary: false,
                labelKey: "boss.todo.handoff.brief",
                disabled: false,
                run: { kind: "brief" },
            },
        ]),
        handoff: {
            requestid: request.requestid,
            from: request.from ?? "",
            to: request.to ?? "",
            fromPlace: request.fromworkspace || request.fromproject || "",
            toPlace: request.toworkspace || request.toproject || "",
            goal: request.goal ?? "",
            files: (brief.files ?? []).map((file) => ({
                name: lastSegment(file.path) || file.path,
                detail: file.lines ? `${file.path}:${file.lines}` : file.path,
            })),
            links: (brief.links ?? []).map((link) => ({ name: link.title || link.url || "", detail: link.url ?? "" })),
            brief,
        },
    };
}

// What the developer has not looked at yet comes before what they have.
function byUrgency(a: ToHandleItem, b: ToHandleItem): number {
    return (
        Number(a.seen) - Number(b.seen) ||
        a.rank - b.rank ||
        (a.since || Infinity) - (b.since || Infinity) ||
        (a.key < b.key ? -1 : 1)
    );
}

// Every row of the To handle tab, most urgent first. The info rows (agents that are done) carry no action and no count.
export function buildToHandle(input: ToHandleInput): ToHandleList {
    const consumed = new Set<string>();
    const handoffs = (input.handoffs ?? []).map((request) => handoffItem(request, input.notifications ?? [], consumed));
    const agents = attentionAgents(input.states).map((info) => agentItem(info, input, consumed));
    const notices = (input.notifications ?? [])
        .filter((entry) => checkNeedsAnswer(entry) && !consumed.has(entry.id))
        .map(noticeItem);
    const prs = Object.values(input.answers ?? {})
        .filter((answer) => answer?.state === "ok")
        .flatMap((answer) => prItems(answer, input.readied));
    const all = [...handoffs, ...agents, ...notices, ...prs];
    const items = all.filter((item) => input.parked?.[item.key] !== true).sort(byUrgency);
    const info: InfoItem[] = Object.values(input.states?.states ?? {})
        .filter((state) => state?.state === "done")
        .map((state) => ({
            key: `done:${state.blockid}`,
            name: agentCallName(state),
            place: workspaceShownName(sessionOf(input.sessions, state.blockid)?.workspacename ?? "", t),
            line: { key: "boss.todo.infoDone" },
        }));
    return {
        items,
        info,
        parked: all.length - items.length,
        parkedKeys: all.filter((item) => input.parked?.[item.key] === true).map((item) => item.key),
    };
}

// What a row is called and what it says, in the user's language: the card, the comm screen and the hover card all read
// the row through these.
export function toHandleName(item: ToHandleItem): string {
    return item.name !== "" ? item.name : item.notice != null ? notificationTitle(item.notice) : "";
}

export function toHandleLineText(item: ToHandleItem): string {
    if (item.lineFromNotice && item.notice != null) {
        return notificationMessage(item.notice);
    }
    return item.line.key != null ? t(item.line.key, item.line.vars) : (item.line.text ?? "");
}

// The row's own sentence, as the comm screen's caption and the hover card say it (FR-BOSS-007, AC11): an agent that
// waits or stopped is a sentence by itself, any other row is its line with the name it is about.
export function toHandleHeadline(item: ToHandleItem): string {
    const name = toHandleName(item);
    const line = toHandleLineText(item);
    if (item.key.startsWith("agent:") && !item.lineFromNotice) {
        return line;
    }
    if (item.key.startsWith("ci:") || item.key.startsWith("ready:")) {
        return name ? `${line} (${name})` : line;
    }
    return name && line ? `${name}: ${line}` : name || line;
}

// The hover card's row for a row To handle: what the badge counts, listed (FR-BOSS-001, AC7).
export function peekRowOf(item: ToHandleItem): PeekWaitingRow {
    const agent = item.key.startsWith("agent:");
    return {
        id: item.key,
        name: toHandleName(item),
        workspace: item.place,
        tone: item.tone,
        line: agent ? agentStateLabel(item.tone === "error" ? "error" : "waiting") : toHandleLineText(item),
    };
}

// The badge counts what the developer has to do, never the info rows, the rows set aside or the ones they already
// acted on (seen, #1938).
export function toHandleBadge(list: ToHandleList): Badge {
    const items = (list?.items ?? []).filter((item) => !item.seen);
    return {
        count: items.length,
        text: badgeCount(items.length),
        tone: items.some((item) => item.tone === "error") ? "error" : "waiting",
    };
}
