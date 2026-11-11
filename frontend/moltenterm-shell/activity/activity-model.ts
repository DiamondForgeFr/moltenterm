// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What runs in the app (FR-BOSS-009, AC85; FR-SHELL-122, #2233): one list of running items that the sidebar's floor and
// the title row's activity icon both read. It is built from what MoltenTerm already holds, so it asks for nothing:
// the agents working (every workspace, Brokk's own session left out), the runs MoltenTerm started (builds, release and
// adapter steps, dependency syncs), the local CI runs, and the GitHub checks of the open pull requests of the
// workspace's projects, from the answers the Integration panel holds. A run that ended is not in it: results are
// Brokk's and the notifications' to tell. Pure, so the rules are tested without a window.

import type { AgentStateInfo } from "../agent-state-model";
import { AiIcon } from "../ai-icon";
import type { ServerText } from "../i18n/server-text";
import type { ReviewPr, ReviewsAnswer } from "../reviews/reviews-model";
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
    return { title: "", detail: "", progress: -1, done: 0, total: 0, ...more };
}

export type ActivityCounts = Record<ActivityKind, number>;

export type ActivitySummary = {
    // The most recently started first.
    items: ActivityItem[];
    count: number;
    kinds: ActivityCounts;
    // The item started most recently: its kind gives the icon's glyph and its target the click's place. Null when
    // nothing runs.
    lead: ActivityItem;
};

export const EmptyActivity: ActivitySummary = {
    items: [],
    count: 0,
    kinds: { agent: 0, build: 0, ci: 0 },
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
};

function isWorkingAgent(info: AgentStateInfo): boolean {
    return info?.state === "working" && !info.own && !!(info.agent || info.agentname);
}

function agentItems(agents: Record<string, AgentStateInfo>): ActivityItem[] {
    return Object.values(agents ?? {})
        .filter(isWorkingAgent)
        .map((info) => ({
            id: `agent:${info.blockid}`,
            kind: "agent" as const,
            startedat: info.started ?? info.since ?? 0,
            target: { type: "agent" as const, blockid: info.blockid, tabid: info.tabid, workspaceid: info.workspaceid },
            about: aboutOf({
                title: (info.firstname || info.agentname || info.agent || "").trim(),
                detail: info.message ?? "",
                detailtext: info.messagetext,
            }),
        }));
}

function workItems(work: readonly WorkItem[]): ActivityItem[] {
    return (work ?? []).map((item) => {
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

export function activityItems(inputs: ActivityInputs): ActivityItem[] {
    return [...agentItems(inputs.agents), ...workItems(inputs.work), ...prItems(inputs.answers, inputs.dirs)];
}

function newestFirst(a: ActivityItem, b: ActivityItem): number {
    return (
        b.startedat - a.startedat ||
        ActivityKinds.indexOf(a.kind) - ActivityKinds.indexOf(b.kind) ||
        a.id.localeCompare(b.id)
    );
}

export function summarizeActivity(items: readonly ActivityItem[]): ActivitySummary {
    if (items == null || items.length === 0) {
        return EmptyActivity;
    }
    const sorted = [...items].sort(newestFirst);
    const kinds: ActivityCounts = { agent: 0, build: 0, ci: 0 };
    for (const item of sorted) {
        kinds[item.kind]++;
    }
    return { items: sorted, count: sorted.length, kinds, lead: sorted[0] };
}

// What a summary is, to tell two of them apart: the same running items saying the same give the same key, whatever else
// about their source moved (an agent's version, a pull request's title).
export function activityKey(summary: ActivitySummary): string {
    return summary.items
        .map((i) => {
            const a = i.about;
            const text = JSON.stringify(a.detailtext ?? null);
            return [i.id, i.startedat, a.title, a.detail, text, a.progress, a.done, a.total].join("@");
        })
        .join("|");
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
    // The accessible name of the indicator: what runs, or that nothing does.
    label: string;
};

export function activityTexts(summary: ActivitySummary, t: ActivityT, tc: ActivityTCount): ActivityTexts {
    if (summary.count === 0) {
        return { list: "", label: t("activity.idle") };
    }
    const list = activityLines(summary, tc).join(", ");
    return { list, label: t("activity.label", { list }) };
}

// The picture of the indicator (FR-BOSS-009, AC85): nothing running is the flame put out, one item the icon of its
// panel, several items the flame lit.
export type ActivityGlyph = "idle" | "agent" | "ci" | "build" | "fire";

export function activityGlyph(summary: ActivitySummary): ActivityGlyph {
    if (summary == null || summary.count === 0) {
        return "idle";
    }
    return summary.count > 1 ? "fire" : summary.lead.kind;
}

// The Font Awesome icons of the app: the AI icon for an agent, the CI/CD view's for CI, a hammer for a build.
export const ActivityGlyphIcons: Record<ActivityGlyph, string> = {
    idle: "fire",
    fire: "fire",
    agent: AiIcon,
    ci: "list-check",
    build: "hammer",
};

export type ActivityGroupId = "agents" | "ci" | "builds";

export type ActivityRow = {
    id: string;
    what: string;
    detail: string;
    // How long ago it started, "" when that is not known.
    since: string;
    target: ActivityTarget;
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

function rowOf(item: ActivityItem, w: ActivityWords): ActivityRow {
    const a = item.about;
    const target = item.target;
    let what = a.title;
    let detail = w.server(a.detailtext, a.detail);
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
    };
}

// The popover's groups, in the order agents, CI, builds, each with its rows newest first; an empty group is left out.
export function activityGroups(summary: ActivitySummary, w: ActivityWords): ActivityGroup[] {
    const rtn: ActivityGroup[] = [];
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

// The popover's title: the furnaces out, a single item running, or how many.
export function activityPopoverTitle(summary: ActivitySummary, t: ActivityT): string {
    if (summary == null || summary.count === 0) {
        return t("activity.popover.idle");
    }
    return summary.count === 1 ? t("activity.popover.one") : t("activity.popover.many", { count: summary.count });
}
