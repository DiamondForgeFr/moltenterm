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
export const CompanionAnswerCommand = "moltencompanionanswer";
export const CompanionDiffCommand = "moltencompaniondiff";

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
    | "choose"
    | "live"
    | "unsupportedformat"
    | "error";

export type TodoStatus = "pending" | "in_progress" | "completed";
export type FileKind = "add" | "update" | "delete";

export type CompanionTodo = { text: string; status: TodoStatus };

export type CompanionToolCall = { id: string; tool: string; args?: string; at?: number; approval?: boolean };

export type CompanionAnswerInfo = { index: number; at?: number; preview: string };

export type CompanionAnswer = { index: number; at?: number; markdown: string; latest?: boolean };

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

export type CompanionCandidate = { path: string; id?: string; started?: number; modified?: number; prompt?: string };

export type CompanionView = {
    blockid: string;
    version: number;
    status: CompanionStatus;
    agent?: string;
    agentname?: string;
    message?: string;
    session?: { path: string; format?: string; linkedby: "hook" | "picked" | "discovery" };
    candidates?: CompanionCandidate[];
    ended?: boolean;
    answers?: CompanionAnswerInfo[];
    latest?: CompanionAnswer;
    files?: CompanionFile[];
    todos?: CompanionTodo[];
    pending?: CompanionToolCall[];
};

// A snapshot and the events race: the newest version wins.
export function newerView(current: CompanionView, next: CompanionView): CompanionView {
    if (next == null) {
        return current;
    }
    if (current == null || next.version >= current.version) {
        return next;
    }
    return current;
}

// The message a companion without a session shows, or null when the session shows.
export function statusMessage(view: CompanionView): { title: string; detail?: string } {
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
                detail: "Start Claude Code or Codex in the terminal: its session shows here.",
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
        case "choose":
            return {
                title: "Which session is this terminal's?",
                detail: "Another terminal runs the same agent in this folder: pick this terminal's session.",
            };
        case "unsupportedformat":
            return {
                title: "Unsupported session format",
                detail: `${view.message || name} writes its transcript in a format this version of MoltenTerm does not read. The terminal is not affected.`,
            };
        case "error":
            return { title: "The companion stopped", detail: view.message };
    }
    return null;
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

const FenceRegex = /^\s{0,3}(```|~~~)/;
const RemoteMediaTagRegex = /<(\/?)(picture|source)\b/gi;

// Wave's markdown keeps <picture> and <source>, whose srcset a browser loads by itself: outside code blocks they are
// shown as text, so an answer never makes the window reach the network. Images without a resolver already show as
// text ([img:...]).
export function companionMarkdown(markdown: string): string {
    if (!markdown) {
        return "";
    }
    let inFence = false;
    return markdown
        .split("\n")
        .map((line) => {
            if (FenceRegex.test(line)) {
                inFence = !inFence;
                return line;
            }
            return inFence ? line : line.replace(RemoteMediaTagRegex, "&lt;$1$2");
        })
        .join("\n");
}
