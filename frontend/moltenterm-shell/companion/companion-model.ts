// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The agent companion (FR-SHELL-018, DS-SHELL-019): what wavesrv reads of the agent session of a terminal
// (pkg/molten/companion), and the pure rules of its view. Pure, so they are tested without a window.

import { getLocale, t } from "../i18n/i18n";

// must match pkg/molten/agentcompanion.go
export const CompanionRoute = "molten:companion";
export const CompanionEvent = "molten:companion";
export const CompanionOpenCommand = "moltencompanionopen";
export const CompanionCloseCommand = "moltencompanionclose";
export const CompanionPickCommand = "moltencompanionpick";
export const CompanionSessionsCommand = "moltencompanionsessions";
export const CompanionAnswerCommand = "moltencompanionanswer";
export const CompanionDiffCommand = "moltencompaniondiff";
export const CompanionUsageCommand = "moltencompanionusage";
export const CompanionUsageGaugesCommand = "moltencompanionusagegauges";
export const CompanionUsageExperimentalCommand = "moltencompanionusageexperimental";
export const CompanionUsageEvent = "molten:companionusage";

export const MoltentermCompanionView = "molten-companion";
// The companion block's meta key naming the terminal it follows.
export const CompanionTargetMetaKey = "molten:companion:block";

// must match pkg/molten/companion/manager.go
export type CompanionStatus =
    | "loading"
    | "noagent"
    | "unsupportedagent"
    | "remote"
    | "searching"
    | "live"
    | "unsupportedformat"
    | "error";

export type TodoStatus = "pending" | "in_progress" | "completed";
export type FileKind = "add" | "update" | "delete";

export type CompanionTodo = { text: string; status: TodoStatus };

export type CompanionToolCall = { id: string; tool: string; args?: string; at?: number; approval?: boolean };

export type CompanionAnswerInfo = { index: number; at?: number; preview: string };

// rev changes with the answer's text; an event leaves the markdown out (elided) when it did not change.
export type CompanionAnswer = {
    index: number;
    rev?: number;
    at?: number;
    markdown: string;
    latest?: boolean;
    elided?: boolean;
};

export type CompanionFile = {
    path: string;
    kind: FileKind;
    added: number;
    removed: number;
    at?: number;
    edits: number;
    truncated?: boolean;
};

export type CompanionDiff = { path: string; kind: FileKind; diff: string; truncated?: boolean };

export type CompanionCandidate = {
    path: string;
    id?: string;
    started?: number;
    modified?: number;
    prompt?: string;
    command?: string;
    // current: the session this terminal's companion shows; elsewhere: another terminal's companion guessed it.
    current?: boolean;
    elsewhere?: boolean;
    // earlier: a session this terminal showed before its current one (#600).
    earlier?: boolean;
    // live: the session the agent runs now, while the companion shows an earlier one.
    live?: boolean;
};

// A session the terminal showed before the one it shows now (/clear, a resume, another run of the agent).
export type CompanionEarlierSession = {
    path: string;
    title?: string;
    command?: string;
    started?: number;
    until?: number;
};

// must match pkg/molten/companion/manager.go and guess.go
export type CompanionLinkKind = "hook" | "picked" | "discovery" | "guessed";
export type CompanionGuess = "started" | "activity" | "recent";

export type CompanionSession = {
    path: string;
    format?: string;
    linkedby: CompanionLinkKind;
    guess?: CompanionGuess;
    title?: string;
    command?: string;
    started?: number;
    // The agent's own name of the session (Claude Code's title, or the user's /rename), and the branch its records
    // last named (#555).
    name?: string;
    branch?: string;
    // earlier: the user chose an earlier session of the terminal; the agent runs a newer one (#600).
    earlier?: boolean;
    livepath?: string;
    // The main agent's model and effort as its transcript records them (the status line's win), the ticket it works on
    // and that ticket's complexity label (#601).
    model?: string;
    effort?: string;
    ticket?: number;
    complexity?: string;
};

// must match pkg/molten/companion/topics.go
export type CompanionPRLink = { number: number; url?: string };
export type CompanionTopic = {
    text: string;
    branch?: string;
    at?: number;
    last?: number;
    tools?: number;
    files?: number;
    prs?: CompanionPRLink[];
};
// quiet: a background agent whose end was never recorded and that wrote nothing for long: not shown as at work.
export type SubagentState = "running" | "done" | "failed" | "stopped" | "quiet";
export type CompanionSubagent = {
    id: string;
    description?: string;
    kind?: string;
    model?: string;
    // effort: absent when neither its transcript nor its call says it (its parent's then, #601).
    effort?: string;
    branch?: string;
    ticket?: number;
    complexity?: string;
    background?: boolean;
    state: SubagentState;
    started?: number;
    ended?: number;
};
export type CompanionActivity = { tool: string; target?: string; at?: number };

export type CompanionView = {
    blockid: string;
    version: number;
    status: CompanionStatus;
    agent?: string;
    agentname?: string;
    message?: string;
    session?: CompanionSession;
    ended?: boolean;
    answers?: CompanionAnswerInfo[];
    latest?: CompanionAnswer;
    files?: CompanionFile[];
    todos?: CompanionTodo[];
    pending?: CompanionToolCall[];
    // The agent's usage page, from its usage adapter (pkg/molten/usage): the frontend holds no provider URL.
    usage?: CompanionUsagePage;
    // What MoltenTerm's launcher added to this run, or why nothing (FR-SHELL-036, pkg/molten/agentintegration.go).
    integration?: CompanionIntegration;
    // The recap (#555): the latest topics, the sub-agents the agent started, its latest tool call.
    topics?: CompanionTopic[];
    subagents?: CompanionSubagent[];
    activity?: CompanionActivity;
    // The terminal's earlier sessions, newest first, the one shown left out (#600).
    earlier?: CompanionEarlierSession[];
};

// The session a transcript path names: its file name without .jsonl (Claude Code's and Codex's session ids end it).
export function sessionKey(path: string): string {
    const name = (path ?? "").split(/[\\/]/).pop() ?? "";
    return name.replace(/\.jsonl$/, "");
}

// current: the agent's session now (shown, or left for an earlier one); earlier: one the terminal moved on from.
export type SessionRelation = "current" | "earlier" | "other" | "";

// How a transcript relates to the terminal the companion follows: the agent's session now, one the terminal showed
// before, or another one (another terminal's, or one this companion never followed). Paths are compared by session
// id, since one may be a symlink's spelling of the other.
export function sessionRelation(path: string, view: CompanionView): SessionRelation {
    const key = sessionKey(path);
    if (!key || view == null) {
        return "";
    }
    const session = view.session;
    if (session?.earlier && sessionKey(session.livepath) === key) {
        return "current";
    }
    if (session != null && sessionKey(session.path) === key) {
        return session.earlier ? "earlier" : "current";
    }
    if ((view.earlier ?? []).some((e) => sessionKey(e.path) === key)) {
        return "earlier";
    }
    return "other";
}

export type HistoryGroup = {
    key: "current" | "live" | "earlier" | "other";
    label: string;
    sessions: CompanionCandidate[];
};

// The history (#600): the session shown first, the agent's own when an earlier one shows, the terminal's earlier
// sessions, then the folder's others.
export function historyGroups(sessions: CompanionCandidate[]): HistoryGroup[] {
    const list = sessions ?? [];
    const rest = list.filter((c) => !c.current && !c.live);
    const groups: HistoryGroup[] = [
        { key: "current", label: t("companion.history.current"), sessions: list.filter((c) => c.current) },
        { key: "live", label: t("companion.history.live"), sessions: list.filter((c) => !c.current && c.live) },
        { key: "earlier", label: t("companion.history.earlier"), sessions: rest.filter((c) => c.earlier) },
        { key: "other", label: t("companion.history.other"), sessions: rest.filter((c) => !c.earlier) },
    ];
    return groups.filter((g) => g.sessions.length > 0);
}

export type CompanionIntegrationItem = { kind: string; name: string; reason?: string };

export type CompanionIntegration = {
    agent: string;
    realpath: string;
    settings?: string;
    mcpconfig?: string;
    args?: string[];
    added?: CompanionIntegrationItem[];
    skipped?: CompanionIntegrationItem[];
    stepaside?: string;
    at?: number;
};

// The start of the launcher's reasons when the settings turn the integration off (agentlaunch/settings.go): the
// user's own choice, not a problem to show.
export const IntegrationTurnedOffPrefix = "the integration is turned off";

// The launcher could not add MoltenTerm's integration to this run (FR-SHELL-036 AC10): the companion says why, since
// the session link and the precise states it would have brought are missing.
export function integrationProblem(view: CompanionView): string {
    const reason = view?.integration?.stepaside;
    if (!reason || reason.startsWith(IntegrationTurnedOffPrefix)) {
        return null;
    }
    return `MoltenTerm added nothing to this run: ${reason}.`;
}

// The launcher added the session link to this run: nothing for the user to paste (FR-SHELL-040-AC6).
export function linksItsSession(view: CompanionView): boolean {
    return isIntegrated(view) && view.integration.added.some((item) => item.kind === "sessionlink");
}

// The run got MoltenTerm's integration (FR-SHELL-040-AC3): the session bar says so.
export function isIntegrated(view: CompanionView): boolean {
    const integration = view?.integration;
    return integration != null && !integration.stepaside && (integration.added?.length ?? 0) > 0;
}

export type CompanionUsagePage = { pageurl: string; pagename: string };

// A snapshot and the events race: the newest version wins. An event without the latest answer's markdown (unchanged)
// keeps the copy the view has; when the view has no copy of that answer, the markdown stays empty and elided, and
// the view asks for it (needsLatest).
export function newerView(current: CompanionView, next: CompanionView): CompanionView {
    if (next == null) {
        return current;
    }
    if (current != null && next.version < current.version) {
        return current;
    }
    const latest = next.latest;
    if (latest?.elided) {
        const kept = current?.latest;
        if (
            kept != null &&
            !kept.elided &&
            kept.index === latest.index &&
            kept.rev === latest.rev &&
            current?.session?.path === next.session?.path
        ) {
            return { ...next, latest: { ...latest, markdown: kept.markdown, elided: false } };
        }
    }
    return next;
}

export function needsLatest(view: CompanionView): boolean {
    return view?.latest?.elided === true;
}

// The message a companion without a session shows, or null when the session shows.
// raw is the backend's own text, shown only under Details (FR-SHELL-053).
export function statusMessage(view: CompanionView): { title: string; detail?: string; raw?: string } {
    const name = view?.agentname || t("companion.status.thisAgent");
    switch (view?.status) {
        case null:
        case undefined:
        case "loading":
            if (view?.session != null) {
                return null;
            }
            return { title: t("companion.status.loading") };
        case "noagent":
            return {
                title: t("companion.status.noAgent"),
                detail: t("companion.status.noAgentDetail"),
            };
        case "unsupportedagent":
            return {
                title: t("companion.status.unsupportedAgent", { name }),
                detail: t("companion.status.unsupportedAgentDetail"),
            };
        case "remote":
            return {
                title: t("companion.status.remote"),
                detail: t("companion.status.remoteDetail"),
            };
        case "searching":
            return {
                title: t("companion.status.searching", { name }),
                detail:
                    view.message ||
                    (linksItsSession(view)
                        ? t("companion.status.searchingIntegrated")
                        : t("companion.status.searchingDetail")),
            };
        case "unsupportedformat":
            return {
                title: t("companion.status.unsupportedFormat"),
                detail: t("companion.status.unsupportedFormatDetail", { name: view.message || name }),
            };
        case "error":
            return {
                title: t("companion.status.error"),
                detail: t("companion.status.errorDetail"),
                raw: view.message,
            };
    }
    return null;
}

// The Usage action (FR-SHELL-026): shown for an agent whose usage adapter gives a page, whatever the agent does
// (working, waiting, exited); never for a terminal without an agent or for an agent without an adapter.
export function usageAction(view: CompanionView): { url: string; title: string } {
    const page = view?.usage;
    if (page == null || !page.pageurl?.startsWith("https://") || !view.agent) {
        return null;
    }
    if (view.status === "noagent" || view.status === "unsupportedagent") {
        return null;
    }
    return {
        url: page.pageurl,
        title: page.pagename ? t("companion.usage.open", { page: page.pagename }) : t("companion.usage.openDefault"),
    };
}

// A pending call is a permission request when the transcript says so (Codex's approval requests), or when the
// agent waits for the user while its last call has no result yet (Claude Code asks before running a tool).
export function permissionRequest(pending: CompanionToolCall[], agentState: string): CompanionToolCall {
    if (pending == null || pending.length === 0) {
        return null;
    }
    const explicit = [...pending].reverse().find((p) => p.approval);
    if (explicit) {
        return explicit;
    }
    if (agentState === "waiting") {
        return pending[pending.length - 1];
    }
    return null;
}

// Arguments read better indented; a plain string stays as it is.
export function formatArgs(args: string): string {
    if (!args) {
        return "";
    }
    try {
        const value = JSON.parse(args);
        if (typeof value === "string") {
            return value;
        }
        return JSON.stringify(value, null, 2);
    } catch {
        return args;
    }
}

export type DiffLineKind = "add" | "del" | "hunk" | "ctx" | "meta";

export function diffLineKind(line: string): DiffLineKind {
    if (line.startsWith("@@")) {
        return "hunk";
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("\\")) {
        return "meta";
    }
    if (line.startsWith("+")) {
        return "add";
    }
    if (line.startsWith("-")) {
        return "del";
    }
    return "ctx";
}

// The line a file's first change starts at, to open the preview there.
export function firstChangedLine(diff: string): number {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)/m.exec(diff ?? "");
    if (m == null) {
        return 0;
    }
    return Math.max(1, Number(m[1]));
}

// The path shown for a file: relative to the session's folder when inside it.
export function displayPath(path: string, folder: string): string {
    if (!folder) {
        return path;
    }
    const prefix = folder.endsWith("/") ? folder : folder + "/";
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

// Answers are browsed from the latest backwards; index is the turn number wavesrv gives.
export function neighbourAnswer(answers: CompanionAnswerInfo[], current: number, step: -1 | 1): number {
    if (answers == null || answers.length === 0) {
        return null;
    }
    const pos = answers.findIndex((a) => a.index === current);
    const from = pos < 0 ? answers.length - 1 : pos;
    const next = from + step;
    if (next < 0 || next >= answers.length) {
        return null;
    }
    return answers[next].index;
}

export function todoCounts(todos: CompanionTodo[]): { done: number; total: number } {
    const list = todos ?? [];
    return { done: list.filter((t) => t.status === "completed").length, total: list.length };
}

export function relativeTime(at: number, now: number): string {
    if (!at) {
        return "";
    }
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 60) {
        return t("companion.time.justNow");
    }
    const m = Math.round(s / 60);
    if (m < 60) {
        return t("companion.time.minutesAgo", { count: m });
    }
    const h = Math.round(m / 60);
    if (h < 24) {
        return t("companion.time.hoursAgo", { count: h });
    }
    return t("companion.time.daysAgo", { count: Math.round(h / 24) });
}

// How the session was linked, as the session bar says it.
export function linkLabel(session: CompanionSession): string {
    switch (session?.linkedby) {
        case "hook":
            return t("companion.link.hook");
        case "picked":
            return t("companion.link.picked");
        case "guessed":
            return t("companion.link.guessed");
    }
    return t("companion.link.folder");
}

// The one-line reason of a guessed link (DS-SHELL-060), or null for any other link.
export function guessHint(session: CompanionSession): string {
    if (session?.linkedby !== "guessed") {
        return null;
    }
    switch (session.guess) {
        case "started":
            return t("companion.guess.started");
        case "activity":
            return t("companion.guess.activity");
    }
    return t("companion.guess.recent");
}

function clockTime(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

// When a session started: the time today, else the date and time.
export function startedLabel(at: number, now: number): string {
    if (!at) {
        return "";
    }
    const day = new Date(at);
    if (day.toDateString() === new Date(now).toDateString()) {
        return t("companion.started", { time: clockTime(at) });
    }
    return t("companion.started", {
        time: `${day.toLocaleDateString(getLocale(), { day: "numeric", month: "short" })} ${clockTime(at)}`,
    });
}

// The linked session's name, as in the history: its first real prompt, else its first command (FR-SHELL-039).
export function sessionTitle(session: CompanionSession): string {
    if (session == null) {
        return null;
    }
    return candidateTitle({
        path: session.path,
        prompt: session.title,
        command: session.command,
        started: session.started,
    });
}

// The line the terminal's agent label adds to its tooltip while its companion shows a session, so the terminal and
// its companion match at a glance.
export function sessionTooltipLine(session: CompanionSession, now: number): string {
    if (session == null) {
        return null;
    }
    const started = startedLabel(session.started, now);
    const guessed = session.linkedby === "guessed" ? ` ${t("companion.guessedSuffix")}` : "";
    return `${t("companion.sessionLine", { title: sessionTitle(session) })}${started ? ` · ${started}` : ""}${guessed}`;
}

export function candidateTitle(c: CompanionCandidate): string {
    if (c.prompt) {
        return c.prompt;
    }
    if (!c.command) {
        return t("companion.noPromptYet");
    }
    if (!c.started) {
        return c.command;
    }
    return `${c.command} · ${clockTime(c.started)}`;
}

const FenceOpenRegex = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/;
const MediaTagRegex = /<(\/?)(picture|source|img|video|audio|iframe|object|embed)\b/gi;

// Wave's markdown keeps raw <picture>, <source> and <img>: a browser loads a srcset by itself, and an <img> without
// a src breaks the markdown component. Outside fenced code blocks (CommonMark fences: a closing fence uses the
// opening character, at least as many times) these tags are shown as text, so an answer never makes the window
// reach the network. Inside fences they are code, already text.
export function companionMarkdown(markdown: string): string {
    if (!markdown) {
        return "";
    }
    let fence: string = null;
    return markdown
        .split("\n")
        .map((line) => {
            if (fence != null) {
                const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
                if (close.test(line)) {
                    fence = null;
                }
                return line;
            }
            const open = FenceOpenRegex.exec(line);
            if (open != null) {
                fence = open[1];
                return line;
            }
            return line.replace(MediaTagRegex, "&lt;$1$2");
        })
        .join("\n");
}
