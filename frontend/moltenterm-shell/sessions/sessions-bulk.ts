// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Bulk actions on sessions (#389, from the Sessions table of FR-SHELL-058): select rows, then end them, restart their
// agents with the current settings, or send their agents one command of the agents' tables. Each action lists the
// sessions first, with the ones it will skip and why, then runs them one after the other and gives a result per
// session. wavesrv checks every session again at the moment it acts (foreground program, agent state), so a session
// that turned busy since the list was drawn is skipped there, never typed into. Kept apart from the components so
// the rules can be tested without the app.

import {
    AgentInputResult,
    ClaudeCommands,
    CodexCommands,
    InterruptAction,
    permissionModeLabel,
} from "../command-panel/agent-commands";
import { DurableSession, SessionEndResult } from "./sessions-model";

// must match pkg/molten/termupdate/restart.go
export const AgentRestartRoute = "molten:termupdate";
export const AgentRestartCommand = "moltenagentrestart";

export type AgentRestartRequest = { blockid: string; agent?: string; mode?: string };

export type AgentRestartOutcome = {
    status: string;
    message: string;
    agent?: string;
    agentname?: string;
    program?: string;
    command?: string;
    guessed?: boolean;
};

export type BulkAction = "end" | "restart" | "send";

export type BulkResultKind = "done" | "skipped" | "failed";

export type BulkResult = { id: string; kind: BulkResultKind; message: string };

// A selected session as an action sees it: skip says why the action leaves it alone.
export type BulkItem = { session: DurableSession; skip?: string };

// One command offered to a mixed selection: per agent, the action of its table (New conversation is /clear in
// Claude Code, /new in Codex).
export type BulkCommand = { id: string; label: string; actions: Record<string, { action: string; command: string }> };

// Commands that open a picker or end the agent are left to each pane: in bulk they would leave several agents
// waiting on a menu, and Quit is what End does.
const NotInBulk = new Set(["model", "resume", "copy", "quit"]);

export const BulkCommands: BulkCommand[] = buildBulkCommands({ claude: ClaudeCommands, codex: CodexCommands });

function buildBulkCommands(tables: Record<string, { action: string; label: string; command: string }[]>) {
    const byLabel = new Map<string, BulkCommand>();
    for (const [agent, defs] of Object.entries(tables)) {
        for (const def of defs) {
            if (NotInBulk.has(def.action)) {
                continue;
            }
            let cmd = byLabel.get(def.label);
            if (cmd == null) {
                cmd = { id: def.action, label: def.label, actions: {} };
                byLabel.set(def.label, cmd);
            }
            cmd.actions[agent] = { action: def.action, command: def.command };
        }
    }
    return [...byLabel.values()];
}

// The permission modes a restart can pass to Claude Code ("" keeps the user's default).
export const RestartModes: { id: string; label: string }[] = [
    { id: "", label: "Keep the default" },
    { id: "default", label: permissionModeLabel("default") },
    { id: "acceptEdits", label: permissionModeLabel("acceptEdits") },
    { id: "plan", label: permissionModeLabel("plan") },
    { id: "bypassPermissions", label: permissionModeLabel("bypassPermissions") },
];

function agentLabel(s: DurableSession): string {
    return s.agentname || s.agent || "The agent";
}

// Why an agent action (restart, send) cannot reach a session, "" when it can.
function agentSkip(s: DurableSession): string {
    if (!s.agent) {
        return "Not a coding agent";
    }
    if (s.connection) {
        return `Runs on ${s.connection}: only local agents`;
    }
    if (!s.shown || !s.blockid) {
        return "Not in a pane: open it first";
    }
    if (s.reason === "olderversion") {
        return "Started by an older MoltenTerm";
    }
    return "";
}

export function bulkSkip(action: BulkAction, s: DurableSession, command?: BulkCommand): string {
    switch (action) {
        case "end":
            return s.canend ? "" : "Cannot be ended now";
        case "restart":
            return agentSkip(s);
        case "send": {
            const skip = agentSkip(s);
            if (skip) {
                return skip;
            }
            if (command != null && command.actions[s.agent] == null) {
                return `${agentLabel(s)} has no ${command.label} command`;
            }
            return "";
        }
    }
    return "";
}

export function bulkItems(action: BulkAction, list: DurableSession[], command?: BulkCommand): BulkItem[] {
    return list.map((session) => {
        const skip = bulkSkip(action, session, command);
        return skip ? { session, skip } : { session };
    });
}

// The note a row shows before the run: an agent busy now is skipped unless its turn ends first.
export function busyNote(action: BulkAction, s: DurableSession, command?: BulkCommand): string {
    if (action === "end" || !s.agent) {
        return "";
    }
    const interrupt = action === "send" && command?.id === InterruptAction;
    if (s.agentstate === "working" && !interrupt) {
        return "working now: skipped unless its turn ends first";
    }
    if (s.agentstate === "waiting") {
        return "waiting for you: skipped unless answered first";
    }
    return "";
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export type BulkConfirmText = { title: string; subtitle: string; confirm: string; running: string };

export function bulkConfirmText(action: BulkAction, items: BulkItem[], command?: BulkCommand): BulkConfirmText {
    const n = items.filter((i) => !i.skip).length;
    const skipped = items.length - n;
    const skipText =
        skipped > 0 ? ` ${plural(skipped, "selected session")} ${skipped === 1 ? "is" : "are"} left out.` : "";
    switch (action) {
        case "end":
            return {
                title: `End ${plural(n, "session")}?`,
                subtitle: `Ending a session stops what runs in it.${skipText}`,
                confirm: `End ${plural(n, "session")}`,
                running: "Ending…",
            };
        case "restart":
            return {
                title: `Restart ${plural(n, "agent")} with the current settings?`,
                subtitle: `Each agent exits and resumes the same conversation in its pane.${skipText}`,
                confirm: `Restart ${plural(n, "agent")}`,
                running: "Restarting…",
            };
        case "send":
            return {
                title: `Send ${command?.label ?? "a command"} to ${plural(n, "agent")}?`,
                subtitle:
                    command?.id === InterruptAction
                        ? `Each agent gets its interrupt key once.${skipText}`
                        : `Each agent gets the command once; an unsent message in its prompt is cleared.${skipText}`,
                confirm: `Send to ${plural(n, "agent")}`,
                running: "Sending…",
            };
    }
}

export function restartResult(id: string, out: AgentRestartOutcome): BulkResult {
    if (out == null) {
        return { id, kind: "failed", message: "MoltenTerm could not reach the terminal." };
    }
    switch (out.status) {
        case "restarted":
            return { id, kind: "done", message: out.message };
        case "agentbusy":
        case "busy":
            return { id, kind: "skipped", message: out.message };
    }
    return { id, kind: "failed", message: out.message || "The agent was not restarted." };
}

export function sendResult(id: string, out: AgentInputResult): BulkResult {
    if (out == null) {
        return { id, kind: "failed", message: "MoltenTerm could not reach the terminal." };
    }
    if (out.result === "sent") {
        return { id, kind: "done", message: out.message };
    }
    switch (out.reason) {
        case "working":
        case "waiting":
        case "busy":
            return { id, kind: "skipped", message: out.message };
    }
    return { id, kind: "failed", message: out.message || "Nothing was typed." };
}

export function endResult(id: string, res: SessionEndResult): BulkResult {
    if (res?.pending) {
        return { id, kind: "done", message: "Ends once its host is back." };
    }
    return { id, kind: "done", message: "Ended." };
}

export function errorResult(id: string, e: any): BulkResult {
    return { id, kind: "failed", message: e?.message ?? String(e) };
}

export type BulkRunners = {
    end: (s: DurableSession) => Promise<SessionEndResult>;
    restart: (req: AgentRestartRequest) => Promise<AgentRestartOutcome>;
    send: (req: {
        blockid: string;
        agent: string;
        action: string;
        confirmeddraft?: boolean;
    }) => Promise<AgentInputResult>;
};

export type BulkOptions = { command?: BulkCommand; mode?: string };

// One session's run. A skipped item is reported without a call.
export async function runBulkItem(
    action: BulkAction,
    item: BulkItem,
    runners: BulkRunners,
    opts: BulkOptions = {}
): Promise<BulkResult> {
    const s = item.session;
    if (item.skip) {
        return { id: s.id, kind: "skipped", message: item.skip };
    }
    try {
        switch (action) {
            case "end":
                return endResult(s.id, await runners.end(s));
            case "restart": {
                // Only Claude Code takes a permission mode: the others keep their own settings.
                const mode = s.agent === "claude" ? opts.mode || undefined : undefined;
                const out = await runners.restart({ blockid: s.blockid, agent: s.agent, mode });
                const result = restartResult(s.id, out);
                if (result.kind === "done" && opts.mode && s.agent !== "claude") {
                    result.message += ` ${agentLabel(s)} kept its own permission settings.`;
                }
                return result;
            }
            case "send": {
                const action = opts.command?.actions[s.agent]?.action;
                const out = await runners.send({
                    blockid: s.blockid,
                    agent: s.agent,
                    action,
                    // The confirmation said an unsent message is cleared: confirming is the consent.
                    confirmeddraft: true,
                });
                return sendResult(s.id, out);
            }
        }
    } catch (e) {
        return errorResult(s.id, e);
    }
    return { id: s.id, kind: "failed", message: "Unknown action." };
}

// Sessions run one after the other: two restarts never type at once, and the results arrive in the list's order.
export async function runBulk(
    action: BulkAction,
    items: BulkItem[],
    runners: BulkRunners,
    opts: BulkOptions,
    onResult: (r: BulkResult) => void
): Promise<BulkResult[]> {
    const rtn: BulkResult[] = [];
    for (const item of items) {
        const r = await runBulkItem(action, item, runners, opts);
        rtn.push(r);
        onResult(r);
    }
    return rtn;
}

export const BulkKindLabels: Record<BulkResultKind, string> = { done: "Done", skipped: "Skipped", failed: "Failed" };

export function bulkSummary(
    action: BulkAction,
    results: BulkResult[]
): { title: string; detail: string; tone: BulkResultKind } {
    const done = results.filter((r) => r.kind === "done").length;
    const skipped = results.filter((r) => r.kind === "skipped").length;
    const failed = results.filter((r) => r.kind === "failed").length;
    const verb = action === "end" ? "Ended" : action === "restart" ? "Restarted" : "Sent to";
    const parts = [];
    if (skipped > 0) {
        parts.push(`${skipped} skipped`);
    }
    if (failed > 0) {
        parts.push(`${failed} failed`);
    }
    return {
        title: `${verb} ${done} of ${plural(results.length, "session")}`,
        detail: parts.join(" · "),
        tone: failed > 0 ? "failed" : skipped > 0 ? "skipped" : "done",
    };
}

// Selection (#389): a click toggles, Shift+click sets the range from the anchor to the row, in table order.
export function toggleSelected(selected: Set<string>, id: string): Set<string> {
    const next = new Set(selected);
    if (next.has(id)) {
        next.delete(id);
    } else {
        next.add(id);
    }
    return next;
}

export function rangeSelected(selected: Set<string>, order: string[], anchor: string, id: string): Set<string> {
    const a = order.indexOf(anchor);
    const b = order.indexOf(id);
    if (a < 0 || b < 0) {
        return toggleSelected(selected, id);
    }
    // The range takes the anchor's state: Shift+click after unchecking a row unchecks the range.
    const on = selected.has(anchor);
    const next = new Set(selected);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
        if (on) {
            next.add(order[i]);
        } else {
            next.delete(order[i]);
        }
    }
    return next;
}

export type CheckState = "none" | "some" | "all";

export function checkState(selected: Set<string>, ids: string[]): CheckState {
    if (ids.length === 0) {
        return "none";
    }
    const n = ids.filter((id) => selected.has(id)).length;
    return n === 0 ? "none" : n === ids.length ? "all" : "some";
}

// A select-all checkbox: all selected clears them, anything else selects them all.
export function toggleAll(selected: Set<string>, ids: string[]): Set<string> {
    const next = new Set(selected);
    if (checkState(selected, ids) === "all") {
        ids.forEach((id) => next.delete(id));
    } else {
        ids.forEach((id) => next.add(id));
    }
    return next;
}

// The selection keeps only the sessions still listed.
export function pruneSelected(selected: Set<string>, order: string[]): Set<string> {
    const live = new Set(order);
    const kept = [...selected].filter((id) => live.has(id));
    return kept.length === selected.size ? selected : new Set(kept);
}
