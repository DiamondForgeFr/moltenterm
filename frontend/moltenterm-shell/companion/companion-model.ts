// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The agent companion (FR-SHELL-018, DS-SHELL-019): what wavesrv reads of the agent session of a terminal
// (pkg/molten/companion), and the pure rules of its view. Pure, so they are tested without a window.

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
};

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
};

export type CompanionIntegrationItem = { kind: string; name: string; reason?: string };

export type CompanionIntegration = {
    agent: string;
    realpath: string;
    added?: CompanionIntegrationItem[];
    skipped?: CompanionIntegrationItem[];
    stepaside?: string;
};

// The launcher could not add MoltenTerm's integration to this run (FR-SHELL-036 AC10): the companion says why, since
// the session link and the precise states it would have brought are missing.
export function integrationProblem(view: CompanionView): string {
    const reason = view?.integration?.stepaside;
    if (!reason) {
        return null;
    }
    return `MoltenTerm added nothing to this run: ${reason}.`;
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
    const name = view?.agentname || "This agent";
    switch (view?.status) {
        case null:
        case undefined:
        case "loading":
            if (view?.session != null) {
                return null;
            }
            return { title: "Reading the session…" };
        case "noagent":
            return {
                title: "No agent runs in this terminal",
                detail: "Start Claude Code here, or attach the companion to another terminal.",
            };
        case "unsupportedagent":
            return { title: `No companion for ${name}`, detail: "The companion reads Claude Code and Codex sessions." };
        case "remote":
            return {
                title: "No companion for a remote terminal",
                detail: "The agent's session lives on the remote machine.",
            };
        case "searching":
            return {
                title: `Waiting for the ${name} session`,
                detail:
                    view.message ||
                    "It shows once the agent writes its first message. A SessionStart hook links it at once (see `molten docs`, agent-states.md).",
            };
        case "unsupportedformat":
            return {
                title: "Unsupported session format",
                detail: `${view.message || name} writes its transcript in a format this version of MoltenTerm does not read. The terminal is not affected.`,
            };
        case "error":
            return {
                title: "The companion stopped",
                detail: "It could not read the agent's session. The terminal is not affected.",
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
    return { url: page.pageurl, title: `Open ${page.pagename || "usage page"}` };
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
        return "just now";
    }
    const m = Math.round(s / 60);
    if (m < 60) {
        return `${m} min ago`;
    }
    const h = Math.round(m / 60);
    if (h < 24) {
        return `${h} h ago`;
    }
    return `${Math.round(h / 24)} d ago`;
}

// How the session was linked, as the session bar says it.
export function linkLabel(session: CompanionSession): string {
    switch (session?.linkedby) {
        case "hook":
            return "linked by the agent's hook";
        case "picked":
            return "picked";
        case "guessed":
            return "guessed";
    }
    return "found by folder";
}

// The one-line reason of a guessed link (DS-SHELL-060), or null for any other link.
export function guessHint(session: CompanionSession): string {
    if (session?.linkedby !== "guessed") {
        return null;
    }
    switch (session.guess) {
        case "started":
            return "Guessed: the session that started after this terminal's agent.";
        case "activity":
            return "Guessed: the session written while this terminal's agent worked.";
    }
    return "Guessed: the most recently updated session of this folder.";
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
        return `started ${clockTime(at)}`;
    }
    return `started ${day.toLocaleDateString([], { day: "numeric", month: "short" })} ${clockTime(at)}`;
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
    const guessed = session.linkedby === "guessed" ? " (guessed)" : "";
    return `Session: ${sessionTitle(session)}${started ? ` · ${started}` : ""}${guessed}`;
}

export function candidateTitle(c: CompanionCandidate): string {
    if (c.prompt) {
        return c.prompt;
    }
    if (!c.command) {
        return "(no prompt yet)";
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
