// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What runs in the window's workspace (FR-BOSS-009, AC85; FR-SHELL-122, #2233, #2261, #2294): one list of running items
// that the sidebar's floor and the title row's activity icon both read. It is built from what MoltenTerm already holds,
// so it asks for nothing: the agents working in the workspace (Brokk's own session left out), the leads whose
// background sub-agents work, as the Integration panel's upcoming work lists them, the runs MoltenTerm started for it
// (builds, release and adapter steps, dependency syncs), its local CI runs, and the GitHub checks of the open pull
// requests of its projects, from the answers the Integration panel holds. Beside what runs it holds what waits for the
// developer: the agents of the workspace in the waiting state. Only Brokk centralises what happens across workspaces:
// an item whose workspace cannot be told is left out rather than shown in every window. A run that ended is not in it:
// results are Brokk's and the notifications' to tell. Pure, so the rules are tested without a window.

import type { AgentStateInfo } from "../agent-state-model";
import { AiIcon } from "../ai-icon";
import type { ServerText } from "../i18n/server-text";
import type { ReviewPr, ReviewsAnswer } from "../reviews/reviews-model";
import type { UpcomingAnswer } from "../reviews/reviews-upcoming-model";
import type { WorkItem } from "../running-work";

export type ActivityKind = "agent" | "build" | "ci";

// The order a tie between kinds is settled in, and the order the counts are listed in.
export const ActivityKinds: readonly ActivityKind[] = ["agent", "build", "ci"];

// Where an activity lives, for a click on the icon. A pull request's CI lives in the Integration panel, a local CI run
// in the CI/CD panel's local tab, a build in its project's tab, an agent in its pane.
export type ActivityTarget =
    | { type: "agent"; blockid: string; tabid?: string; workspaceid?: string }
    | { type: "build"; dir: string; workspaceid?: string }
    | { type: "local-ci"; dir: string }
    | { type: "pr-ci"; dir: string; number: number; url?: string };

// What a row of the popover says about an item, as its source holds it; the words are made where they show.
export type ActivityAbout = {
    // An agent's first name, a build's title; empty for CI, whose row names it.
    title: string;
    // The agent's line, the phase or job running.
    detail: string;
    detailtext?: ServerText;
    // The share done, 0 to 1, or -1 when it is not known (a local CI run).
    progress: number;
    // A pull request's checks on GitHub: how many ended, out of how many.
    done: number;
    total: number;
    // An agent's running sub-agents (#2294): the lead is one item whatever their number.
    subagents: number;
};

export type ActivityItem = {
    id: string;
    kind: ActivityKind;
    // ms since the epoch; 0 when it is not known, and then the item never leads over one that is.
    startedat: number;
    target: ActivityTarget;
    about: ActivityAbout;
};

function aboutOf(more: Partial<ActivityAbout> = {}): ActivityAbout {
    return { title: "", detail: "", progress: -1, done: 0, total: 0, subagents: 0, ...more };
}

// An agent of the workspace that waits for the developer (#2294): a question, a permission, a decision stop. It is not
// running work, so it is not an item: it adds no heat and no count.
export type ActivityWaiting = {
    id: string;
    // The agent's call name: its first name, else its tool's.
    name: string;
    // The shown name of the tab it waits in, "" when it cannot be told.
    place: string;
    // What it says it waits for, as its state holds it.
    detail: string;
    detailtext?: ServerText;
    // ms since the epoch the agent started waiting; 0 when it is not known.
    since: number;
    target: Extract<ActivityTarget, { type: "agent" }>;
};

export type ActivityCounts = Record<ActivityKind, number>;

export type ActivitySummary = {
    // The most recently started first.
    items: ActivityItem[];
    count: number;
    kinds: ActivityCounts;
    // The running sub-agents of the agents in items, all leads together.
    subagents: number;
    // The agents of the workspace that wait for the developer, the one that has waited longest first.
    waiting: ActivityWaiting[];
    // The item started most recently: its kind gives the icon's glyph and its target the click's place. Null when
    // nothing runs.
    lead: ActivityItem;
};

export const EmptyActivity: ActivitySummary = {
    items: [],
    count: 0,
    kinds: { agent: 0, build: 0, ci: 0 },
    subagents: 0,
    waiting: [],
    lead: null,
};

// The pull requests named in a tooltip line before "+N".
export const NamedPrs = 3;

export type ActivityInputs = {
    agents: Record<string, AgentStateInfo>;
    work: readonly WorkItem[];
    // The Integration panel's answer of each project, by repository folder.
    answers: Record<string, ReviewsAnswer>;
    // The repository folders of the workspace's projects: the pull requests followed.
    dirs: readonly string[];
    // The window's workspace: the agents and runs shown are its own.
    workspaceid: string;
    // The folders of the workspace's projects and their repositories: a run that carries no workspace is the
    // workspace's when it runs in one of them.
    folders: readonly string[];
    // The Integration panel's upcoming work of each project, by repository folder: where the sub-agents are read from,
    // the one reading that panel lists them from (#2294).
    upcoming?: Record<string, UpcomingAnswer>;
    // The shown name of the tab of each agent, by tab id: where a waiting agent waits.
    tabNames?: Record<string, string>;
};

// An agent of the workspace, Brokk's own session left out. The workspace is the window's: an agent whose workspace
// cannot be told is not (#2261).
function isWorkspaceAgent(info: AgentStateInfo, workspaceid: string): boolean {
    return !!workspaceid && !!info && !info.own && !!(info.agent || info.agentname) && info.workspaceid === workspaceid;
}

// The sub-agents the Integration panel shows at work (reviews-upcoming-model.ts, subagentFacts): any state wavesrv does
// not name is running there too.
export function subagentIsRunning(state: string): boolean {
    return state !== "quiet" && state !== "done";
}

// The running sub-agents of each agent of the workspace, by the agent's block (#2294): read from the upcoming work of
// the workspace's projects, where the Integration panel lists them under In progress, Coming and the delegated agents.
// A sub-agent counts through its lead alone, and only when the lead is an agent of the workspace. A sub-agent that no
// worktree holds is listed in the answer of every project: it counts once.
export function runningSubagents(
    upcoming: Record<string, UpcomingAnswer> | undefined,
    dirs: readonly string[],
    agents: Record<string, AgentStateInfo>,
    workspaceid: string
): Map<string, number> {
    const rtn = new Map<string, number>();
    const seen = new Set<string>();
    for (const dir of dirs ?? []) {
        for (const sub of upcoming?.[dir]?.agents ?? []) {
            if (sub.kind !== "subagent" || !subagentIsRunning(sub.state) || !sub.parentblockid) {
                continue;
            }
            if (!isWorkspaceAgent(agents?.[sub.parentblockid], workspaceid)) {
                continue;
            }
            const identity = sub.agentid || `${sub.branch}|${sub.worktree}|${sub.description}|${sub.started}`;
            const key = `${sub.parentblockid}\n${identity}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            rtn.set(sub.parentblockid, (rtn.get(sub.parentblockid) ?? 0) + 1);
        }
    }
    return rtn;
}

// An agent is running work when its own turn works, or when sub-agents of it work while it is idle: a lead that handed
// its work to background sub-agents has nothing left to do itself (#2294).
function agentItems(
    agents: Record<string, AgentStateInfo>,
    workspaceid: string,
    subagents: ReadonlyMap<string, number>
): ActivityItem[] {
    return Object.values(agents ?? {})
        .filter((info) => {
            const subs = Math.max(subagents.get(info.blockid) ?? 0, info.subagents ?? 0);
            return isWorkspaceAgent(info, workspaceid) && (info.state === "working" || subs > 0);
        })
        .map((info) => {
            const subs = Math.max(subagents.get(info.blockid) ?? 0, info.subagents ?? 0);
            // A lead that works only through its sub-agents says so in its message; the row says it once.
            const said = subs > 0 && info.background;
            return {
                id: `agent:${info.blockid}`,
                kind: "agent" as const,
                startedat: info.started ?? info.since ?? 0,
                target: {
                    type: "agent" as const,
                    blockid: info.blockid,
                    tabid: info.tabid,
                    workspaceid: info.workspaceid,
                },
                about: aboutOf({
                    title: (info.firstname || info.agentname || info.agent || "").trim(),
                    detail: said ? "" : (info.message ?? ""),
                    detailtext: said ? undefined : info.messagetext,
                    subagents: subs,
                }),
            };
        });
}

// The agents of the workspace that wait for the developer (#2294). The one that has waited longest comes first: it is
// the one that has kept somebody waiting.
function waitingAgents(
    agents: Record<string, AgentStateInfo>,
    workspaceid: string,
    tabNames: Record<string, string> | undefined
): ActivityWaiting[] {
    return Object.values(agents ?? {})
        .filter((info) => info.state === "waiting" && isWorkspaceAgent(info, workspaceid))
        .map((info) => ({
            id: `waiting:${info.blockid}`,
            name: (info.firstname || info.agentname || info.agent || "").trim(),
            place: (info.tabid ? tabNames?.[info.tabid] : "") ?? "",
            detail: info.message ?? "",
            detailtext: info.messagetext,
            since: info.since ?? 0,
            target: { type: "agent" as const, blockid: info.blockid, tabid: info.tabid, workspaceid: info.workspaceid },
        }))
        .sort((a, b) => (a.since || Infinity) - (b.since || Infinity) || a.id.localeCompare(b.id));
}

function isWorkspaceWork(item: WorkItem, workspaceid: string, folders: readonly string[]): boolean {
    if (item.workspaceid) {
        return !!workspaceid && item.workspaceid === workspaceid;
    }
    return !!item.dir && (folders ?? []).includes(item.dir);
}

function workItems(work: readonly WorkItem[], workspaceid: string, folders: readonly string[]): ActivityItem[] {
    const own = (work ?? []).filter((item) => isWorkspaceWork(item, workspaceid, folders));
    return own.map((item) => {
        const startedat = item.startedat ?? 0;
        const about = aboutOf({
            title: item.kind === "ci" ? "" : item.title,
            detail: item.detail ?? "",
            detailtext: item.detailtext,
            progress: item.progress ?? -1,
        });
        if (item.kind === "ci") {
            return {
                id: `work:${item.id}`,
                kind: "ci" as const,
                startedat,
                target: { type: "local-ci" as const, dir: item.dir },
                about,
            };
        }
        return {
            id: `work:${item.id}`,
            kind: "build" as const,
            startedat,
            target: { type: "build" as const, dir: item.dir, workspaceid: item.workspaceid },
            about,
        };
    });
}

// A check GitHub runs: pending and not the local CI's (the local runs are in the work list, once).
function remoteRunning(pr: ReviewPr) {
    return (pr.ci?.checks ?? []).filter((c) => c.state === "pending" && !c.local);
}

function parsedMs(text: string): number {
    const ms = text ? Date.parse(text) : NaN;
    return Number.isFinite(ms) ? ms : 0;
}

function prStart(pr: ReviewPr, running: ReturnType<typeof remoteRunning>): number {
    const starts = running.map((c) => parsedMs(c.startedat)).filter((ms) => ms > 0);
    if (starts.length > 0) {
        return Math.min(...starts);
    }
    return parsedMs(pr.updatedat);
}

function prItems(answers: Record<string, ReviewsAnswer>, dirs: readonly string[]): ActivityItem[] {
    const rtn: ActivityItem[] = [];
    for (const dir of dirs ?? []) {
        const answer = answers?.[dir];
        if (answer?.state !== "ok") {
            continue;
        }
        const seen = new Set<number>();
        for (const pr of [...(answer.ready ?? []), ...(answer.drafts ?? [])]) {
            if (seen.has(pr.number)) {
                continue;
            }
            seen.add(pr.number);
            const running = remoteRunning(pr);
            if (running.length === 0) {
                continue;
            }
            const remote = (pr.ci?.checks ?? []).filter((c) => !c.local);
            rtn.push({
                id: `pr:${dir}#${pr.number}`,
                kind: "ci",
                startedat: prStart(pr, running),
                target: { type: "pr-ci", dir, number: pr.number, url: pr.url },
                about: aboutOf({ done: remote.length - running.length, total: remote.length }),
            });
        }
    }
    return rtn;
}

// The agents of the workspace that are open, the ones a sub-agent can belong to (#2294): the upcoming work is asked
// again when one starts or closes, and not at all while none is open.
export function openAgentsKey(agents: Record<string, AgentStateInfo>, workspaceid: string): string {
    return Object.values(agents ?? {})
        .filter((info) => isWorkspaceAgent(info, workspaceid))
        .map((info) => `${info.blockid}@${info.started ?? 0}`)
        .sort()
        .join(",");
}

export function activityItems(inputs: ActivityInputs): ActivityItem[] {
    const subagents = runningSubagents(inputs.upcoming, inputs.dirs, inputs.agents, inputs.workspaceid);
    return [
        ...agentItems(inputs.agents, inputs.workspaceid, subagents),
        ...workItems(inputs.work, inputs.workspaceid, inputs.folders),
        ...prItems(inputs.answers, inputs.dirs),
    ];
}

export function activityWaiting(inputs: ActivityInputs): ActivityWaiting[] {
    return waitingAgents(inputs.agents, inputs.workspaceid, inputs.tabNames);
}

function newestFirst(a: ActivityItem, b: ActivityItem): number {
    return (
        b.startedat - a.startedat ||
        ActivityKinds.indexOf(a.kind) - ActivityKinds.indexOf(b.kind) ||
        a.id.localeCompare(b.id)
    );
}

export function summarizeActivity(
    items: readonly ActivityItem[],
    waiting: readonly ActivityWaiting[] = []
): ActivitySummary {
    if (items == null || items.length === 0) {
        return waiting.length === 0 ? EmptyActivity : { ...EmptyActivity, waiting: [...waiting] };
    }
    const sorted = [...items].sort(newestFirst);
    const kinds: ActivityCounts = { agent: 0, build: 0, ci: 0 };
    let subagents = 0;
    for (const item of sorted) {
        kinds[item.kind]++;
        subagents += item.about.subagents;
    }
    return { items: sorted, count: sorted.length, kinds, subagents, waiting: [...waiting], lead: sorted[0] };
}

// What a summary is, to tell two of them apart: the same running items saying the same give the same key, whatever else
// about their source moved (an agent's version, a pull request's title).
export function activityKey(summary: ActivitySummary): string {
    const running = summary.items
        .map((i) => {
            const a = i.about;
            const text = JSON.stringify(a.detailtext ?? null);
            return [i.id, i.startedat, a.title, a.detail, text, a.progress, a.done, a.total, a.subagents].join("@");
        })
        .join("|");
    const waiting = summary.waiting
        .map((w) => [w.id, w.name, w.place, w.detail, JSON.stringify(w.detailtext ?? null), w.since].join("@"))
        .join("|");
    return `${running}#${waiting}`;
}

// The words of the tooltip and the accessible name. Pure over the translation functions, so a test drives them with
// fakes. tc picks the plural form of a key (`.one` / `.other`).
export type ActivityT = (key: string, vars?: Record<string, string | number>) => string;
export type ActivityTCount = (key: string, count: number, vars?: Record<string, string | number>) => string;

function prNumbers(items: readonly ActivityItem[]): string {
    const numbers = items
        .map((i) => (i.target.type === "pr-ci" ? i.target.number : 0))
        .filter((n) => n > 0)
        .sort((a, b) => a - b);
    const named = numbers.slice(0, NamedPrs).map((n) => `#${n}`);
    const more = numbers.length - named.length;
    return more > 0 ? `${named.join(", ")} +${more}` : named.join(", ");
}

// What runs, one line per sort of item: "2 agents", "CI of PR #12", "a local CI run", "a build".
export function activityLines(summary: ActivitySummary, tc: ActivityTCount): string[] {
    const lines: string[] = [];
    const ofTarget = (type: ActivityTarget["type"]) => summary.items.filter((i) => i.target.type === type);
    if (summary.kinds.agent > 0) {
        lines.push(tc("activity.agents", summary.kinds.agent));
    }
    if (summary.subagents > 0) {
        lines.push(tc("activity.subagents", summary.subagents));
    }
    const prs = ofTarget("pr-ci");
    if (prs.length > 0) {
        lines.push(tc("activity.prCi", prs.length, { numbers: prNumbers(prs) }));
    }
    const local = ofTarget("local-ci");
    if (local.length > 0) {
        lines.push(tc("activity.localCi", local.length));
    }
    if (summary.kinds.build > 0) {
        lines.push(tc("activity.builds", summary.kinds.build));
    }
    return lines;
}

// Where a click on a row goes, said before it goes there (the row's tooltip).
export function activityWhereKey(target: ActivityTarget): string {
    switch (target?.type) {
        case "agent":
            return "activity.open.agent";
        case "build":
            return "activity.open.build";
        case "local-ci":
            return "activity.open.localCi";
        case "pr-ci":
            return "activity.open.prCi";
    }
    return "";
}

export type ActivityTexts = {
    // The list of what runs, comma-separated.
    list: string;
    // The accessible name of the indicator: what runs and what waits for the developer, or that nothing does.
    label: string;
};

export function activityTexts(summary: ActivitySummary, t: ActivityT, tc: ActivityTCount): ActivityTexts {
    const waiting = summary.waiting ?? [];
    if (summary.count === 0 && waiting.length === 0) {
        return { list: "", label: t("activity.idle") };
    }
    const list = summary.count === 0 ? "" : activityLines(summary, tc).join(", ");
    const parts: string[] = [];
    if (summary.count > 0) {
        parts.push(t("activity.label", { list }));
    }
    if (waiting.length > 0) {
        parts.push(t("activity.waitingLabel", { list: waiting.map((w) => w.name).join(", ") }));
    }
    return { list, label: parts.join(". ") };
}

// The picture of the indicator (FR-BOSS-009, AC85): nothing running is the flame put out, one item the icon of its
// panel, several items the flame lit. An agent that waits for the developer, with nothing running, is its own picture:
// the agent's icon in a complete ring (#2294).
export type ActivityGlyph = "idle" | "agent" | "ci" | "build" | "fire" | "wait";

export function activityGlyph(summary: ActivitySummary): ActivityGlyph {
    if (summary == null) {
        return "idle";
    }
    if (summary.count === 0) {
        return summary.waiting?.length > 0 ? "wait" : "idle";
    }
    return summary.count > 1 ? "fire" : summary.lead.kind;
}

// The Font Awesome icons of the app: the AI icon for an agent, the CI/CD view's for CI, a hammer for a build.
export const ActivityGlyphIcons: Record<ActivityGlyph, string> = {
    idle: "fire",
    fire: "fire",
    agent: AiIcon,
    wait: AiIcon,
    ci: "list-check",
    build: "hammer",
};

export type ActivityGroupId = "waiting" | "agents" | "ci" | "builds";

export type ActivityRow = {
    id: string;
    what: string;
    detail: string;
    // How long ago it started (or began to wait), "" when that is not known.
    since: string;
    target: ActivityTarget;
    // Where a click goes, said in the row's tooltip.
    whereKey: string;
};

export type ActivityGroup = { id: ActivityGroupId; title: string; rows: ActivityRow[] };

// What the rows need to be worded: the translation functions, the age of a start, and wavesrv's sentences in the
// interface language. Passed in, so that a test drives them with fakes.
export type ActivityWords = {
    t: ActivityT;
    tc: ActivityTCount;
    now: number;
    age: (startedat: number, now: number) => string;
    server: (text: ServerText, english: string) => string;
};

const GroupOfKind: Record<ActivityKind, ActivityGroupId> = { agent: "agents", ci: "ci", build: "builds" };
const GroupOrder: readonly ActivityGroupId[] = ["agents", "ci", "builds"];

function waitingRowOf(waiting: ActivityWaiting, w: ActivityWords): ActivityRow {
    return {
        id: waiting.id,
        what: w.t("activity.row.asks", { name: waiting.name }),
        detail: waiting.place,
        since: waiting.since > 0 ? w.age(waiting.since, w.now) : "",
        target: waiting.target,
        whereKey: "activity.open.waiting",
    };
}

function rowOf(item: ActivityItem, w: ActivityWords): ActivityRow {
    const a = item.about;
    const target = item.target;
    let what = a.title;
    let detail = w.server(a.detailtext, a.detail);
    if (a.subagents > 0) {
        detail = [detail, w.tc("activity.row.subagents", a.subagents)].filter((s) => s).join(" · ");
    }
    if (target.type === "local-ci") {
        what = w.t("activity.row.localCi");
        if (a.progress >= 0) {
            const percent = w.t("activity.row.percent", { percent: Math.round(a.progress * 100) });
            detail = [detail, percent].filter((s) => s).join(" · ");
        }
    }
    if (target.type === "pr-ci") {
        what = w.t("activity.row.pr", { number: target.number });
        detail = a.total > 0 ? w.t("activity.row.prChecks", { done: a.done, total: a.total }) : "";
    }
    return {
        id: item.id,
        what,
        detail,
        since: item.startedat > 0 ? w.age(item.startedat, w.now) : "",
        target,
        whereKey: activityWhereKey(target),
    };
}

// The popover's groups: what waits for the developer first, one row per agent, then agents, CI and builds, each with
// its rows newest first; an empty group is left out.
export function activityGroups(summary: ActivitySummary, w: ActivityWords): ActivityGroup[] {
    const rtn: ActivityGroup[] = [];
    const waiting = summary?.waiting ?? [];
    if (waiting.length > 0) {
        rtn.push({ id: "waiting", title: w.t("activity.group.waiting"), rows: waiting.map((x) => waitingRowOf(x, w)) });
    }
    for (const id of GroupOrder) {
        const items = (summary?.items ?? []).filter((i) => GroupOfKind[i.kind] === id);
        if (items.length === 0) {
            continue;
        }
        const title = id === "ci" ? w.t("activity.group.ci") : w.tc(`activity.group.${id}`, items.length);
        rtn.push({ id, title, rows: items.map((i) => rowOf(i, w)) });
    }
    return rtn;
}

// The popover's title: the furnaces out, a single item running, or how many; with nothing running, an agent that waits
// for the developer is what it says.
export function activityPopoverTitle(summary: ActivitySummary, t: ActivityT): string {
    if (summary == null || summary.count === 0) {
        return summary?.waiting?.length > 0 ? t("activity.popover.waiting") : t("activity.popover.idle");
    }
    return summary.count === 1 ? t("activity.popover.one") : t("activity.popover.many", { count: summary.count });
}
