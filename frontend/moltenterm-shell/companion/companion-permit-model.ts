// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion answers an agent's permission request, and the main agent can run on its own for a while (FR-SHELL-018,
// FR-SHELL-063, #2474). wavesrv's gate (pkg/molten/keepawake/gate.go) holds the request of the agent's PermissionRequest
// hook while a window shows the terminal's companion, and keeps which agent sessions approve their own requests; these
// are the types it shows the windows and what the permission block, the Permissions control and the autonomous chip read
// from them. No React here, so the rules are tested without a window.

import type { ServerText } from "../i18n/server-text";
import type { KeepAwakeApproval, KeepAwakeState } from "../keepawake-model";
import type { CompanionView } from "./companion-model";

// must match pkg/molten/keepawake/gate.go
export const PermitRoute = "molten:agentpermit";
export const PermitEvent = "molten:agentpermit";
export const PermitStateCommand = "agentpermitstate";
export const PermitAnswerCommand = "agentpermitanswer";
export const PermitModeCommand = "agentpermitmode";
export const PermitWatchCommand = "agentpermitwatch";

// How long a window's word that it shows the terminal's companion holds (WatchLease) is longer than three renewals.
export const PermitWatchEveryMs = 10_000;

export type PermitDecision = "allow" | "deny" | "terminal";
export type PermitAnswerStatus = "answered" | "gone" | "invalid";
export type PermitRequestState = "held" | "terminal";

// must match GateRequest in pkg/molten/keepawake/gate.go
export type PermitRequest = {
    id: string;
    blockid: string;
    sessionid?: string;
    agent?: string;
    tool: string;
    toolinput?: Record<string, any>;
    // A long text of the input is shown cut.
    clipped?: boolean;
    cwd?: string;
    at: number;
    state: PermitRequestState;
    // When a held request goes back to the agent's own prompt (Unix ms).
    deadline?: number;
    // Why the request stays with the developer (the deny list), with its code.
    reason?: string;
    reasontext?: ServerText;
};

export type PermitMode = "ask" | "for" | "always";
export type PermitPeriod = "15m" | "1h" | "4h" | "tonight";
export const PermitPeriods: readonly PermitPeriod[] = ["15m", "1h", "4h", "tonight"];

// must match Autonomy in pkg/molten/keepawake/gate.go
export type PermitAutonomy = {
    blockid: string;
    sessionid: string;
    agent?: string;
    mode: "for" | "always";
    since: number;
    // When a period ends (Unix ms); absent for always.
    until?: number;
    approved: number;
};

export type PermitState = {
    version: number;
    requests: PermitRequest[];
    autonomy: PermitAutonomy[];
};

export const EmptyPermitState: PermitState = { version: -1, requests: [], autonomy: [] };

// The newer state wins: events and the first read may cross.
export function applyPermitState(current: PermitState, next: PermitState): PermitState {
    if (next == null || typeof next.version !== "number" || next.version < current.version) {
        return current;
    }
    return { version: next.version, requests: next.requests ?? [], autonomy: next.autonomy ?? [] };
}

// must match GateWatchResult in pkg/molten/keepawake/gate.go
export type PermitWatch = {
    blockid: string;
    // The terminal's agent session can be set to approve automatically.
    available: boolean;
    // Its requests are held for the companion.
    holds: boolean;
    reason?: string;
    reasontext?: ServerText;
};

// must match GateModeResult in pkg/molten/keepawake/gate.go
export type PermitModeResult = {
    status: "set" | "invalid" | "unavailable";
    autonomy?: PermitAutonomy;
    reason?: string;
    reasontext?: ServerText;
};

export type PermitAnswerResult = { status: PermitAnswerStatus };

// ── The session ─────────────────────────────────────────────────────────────────────────────────────────────────────

const SessionIdTail = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The id the agent's hooks name a session by: Claude Code's transcript is named by it, Codex's rollout ends with it.
export function agentSessionId(path: string): string {
    const name = (path ?? "").split(/[\\/]/).pop() ?? "";
    const key = name.replace(/\.jsonl$/, "");
    return SessionIdTail.exec(key)?.[0] ?? key;
}

// The session the agent runs now, whichever one the companion shows: an earlier session is shown while a newer one runs.
export function liveSessionId(view: CompanionView): string {
    const session = view?.session;
    if (session == null) {
        return "";
    }
    return agentSessionId(session.earlier && session.livepath ? session.livepath : session.path);
}

// ── What a window reads ─────────────────────────────────────────────────────────────────────────────────────────────

// The request the terminal's agent waits on: the newest of the terminal.
export function requestOfBlock(state: PermitState, blockId: string): PermitRequest {
    let rtn: PermitRequest = null;
    for (const r of state?.requests ?? []) {
        if (r.blockid === blockId && (rtn == null || r.at >= rtn.at)) {
            rtn = r;
        }
    }
    return rtn;
}

export function autonomyEnded(autonomy: PermitAutonomy, now: number): boolean {
    return autonomy.until != null && autonomy.until > 0 && now >= autonomy.until;
}

// The session's autonomous mode, null while it asks (or its period ended).
export function autonomyOf(state: PermitState, blockId: string, sessionId: string, now: number): PermitAutonomy {
    if (!blockId || !sessionId) {
        return null;
    }
    const wanted = sessionId.toLowerCase();
    const found = (state?.autonomy ?? []).find((a) => a.blockid === blockId && a.sessionid.toLowerCase() === wanted);
    return found != null && !autonomyEnded(found, now) ? found : null;
}

export function modeOf(autonomy: PermitAutonomy): PermitMode {
    return autonomy?.mode ?? "ask";
}

// How much of a period is left, null for "always" and for no mode.
export function autonomyLeftMs(autonomy: PermitAutonomy, now: number): number {
    if (autonomy == null || autonomy.mode !== "for" || !autonomy.until) {
        return null;
    }
    return Math.max(0, autonomy.until - now);
}

const PeriodMs: [PermitPeriod, number][] = [
    ["15m", 15 * 60_000],
    ["1h", 60 * 60_000],
    ["4h", 4 * 60 * 60_000],
];

// The period the developer chose, read back from the mode's length (the evening is whatever else a period is).
export function periodOf(autonomy: PermitAutonomy): PermitPeriod {
    if (autonomy == null || autonomy.mode !== "for" || !autonomy.until) {
        return null;
    }
    const length = autonomy.until - autonomy.since;
    return PeriodMs.find(([, ms]) => ms === length)?.[0] ?? "tonight";
}

// The approvals the session's mode made, newest first: the coffee's own log holds them (FR-SHELL-063 AC12).
export function autonomousApprovals(state: KeepAwakeState, autonomy: PermitAutonomy): KeepAwakeApproval[] {
    if (autonomy == null) {
        return [];
    }
    const session = autonomy.sessionid.toLowerCase();
    return (state?.approvals ?? []).filter(
        (a) =>
            a.source === "autonomous" &&
            a.blockid === autonomy.blockid &&
            (a.sessionid ?? "").toLowerCase() === session &&
            a.at >= autonomy.since
    );
}

// ── What the block shows of a request ───────────────────────────────────────────────────────────────────────────────

export type PermitKind = "command" | "edit" | "read" | "web" | "tool";

const CommandTools = new Set(["Bash", "shell", "local_shell", "exec_command"]);
const EditTools = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch"]);
const ReadTools = new Set(["Read", "Glob", "Grep", "LS"]);
const WebTools = new Set(["WebFetch", "WebSearch"]);

export function permitKind(tool: string): PermitKind {
    if (CommandTools.has(tool)) {
        return "command";
    }
    if (EditTools.has(tool)) {
        return "edit";
    }
    if (ReadTools.has(tool)) {
        return "read";
    }
    if (WebTools.has(tool)) {
        return "web";
    }
    return "tool";
}

// The exact text the developer decides on, in the mono box: a command as typed (Codex's argv joined), else the tool's
// whole input, indented.
export function requestText(request: PermitRequest): string {
    const input = request?.toolinput ?? {};
    const command = input.command;
    if (permitKind(request?.tool) === "command") {
        if (typeof command === "string" && command !== "") {
            return command;
        }
        if (Array.isArray(command) && command.every((w) => typeof w === "string")) {
            return command.join(" ");
        }
    }
    if (Object.keys(input).length === 0) {
        return "";
    }
    return JSON.stringify(input, null, 2);
}

// The project the agent runs in: the last folder of its working directory.
export function folderName(cwd: string): string {
    const parts = (cwd ?? "").split(/[\\/]/).filter((p) => p !== "");
    return parts[parts.length - 1] ?? "";
}

// "1:52": the time left for the developer's answer, never negative.
export function countdownText(deadline: number, now: number): string {
    const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// A request the developer can answer here: held, and with time left.
export function answerable(request: PermitRequest, now: number): boolean {
    return request?.state === "held" && (request.deadline == null || request.deadline > now);
}

// A reason starts a sentence.
export function sentence(text: string): string {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}
