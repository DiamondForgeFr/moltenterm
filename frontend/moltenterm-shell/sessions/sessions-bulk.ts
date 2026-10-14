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
import { t } from "../i18n/i18n";
import { DurableSession, endRunningNote, SessionEndResult } from "./sessions-model";

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
// Claude Code, /new in Codex). label is the English identity the agents' tables share; labelKey is what is shown.
export type BulkCommand = {
    id: string;
    label: string;
    labelKey: string;
    actions: Record<string, { action: string; command: string }>;
};

// Commands that open a picker or end the agent are left to each pane: in bulk they would leave several agents
// waiting on a menu, and Quit is what End does.
const NotInBulk = new Set(["model", "resume", "copy", "quit"]);

export const BulkCommands: BulkCommand[] = buildBulkCommands({ claude: ClaudeCommands, codex: CodexCommands });

function buildBulkCommands(
    tables: Record<string, { action: string; label: string; labelKey: string; command: string }[]>
) {
    const byLabel = new Map<string, BulkCommand>();
    for (const [agent, defs] of Object.entries(tables)) {
        for (const def of defs) {
            if (NotInBulk.has(def.action)) {
                continue;
            }
            let cmd = byLabel.get(def.label);
            if (cmd == null) {
                cmd = { id: def.action, label: def.label, labelKey: def.labelKey, actions: {} };
                byLabel.set(def.label, cmd);
            }
            cmd.actions[agent] = { action: def.action, command: def.command };
        }
    }
    return [...byLabel.values()];
}

// The shown name of a bulk command, in the interface language.
export function bulkCommandLabel(command: BulkCommand): string {
    return command?.labelKey ? t(command.labelKey) : (command?.label ?? "");
}

// The permission modes a restart can pass to Claude Code ("" keeps the user's default), labelled when shown.
export function restartModes(): { id: string; label: string }[] {
    return [
        { id: "", label: t("sessions.bulk.keepDefault") },
        ...["default", "acceptEdits", "plan", "bypassPermissions"].map((id) => ({
            id,
            label: permissionModeLabel(id),
        })),
    ];
}

function agentLabel(s: DurableSession): string {
    return s.agentname || s.agent || t("sessions.bulk.theAgent");
}

// Why an agent action (restart, send) cannot reach a session, "" when it can.
function agentSkip(s: DurableSession): string {
    if (!s.agent) {
        return t("sessions.bulk.skip.notAgent");
    }
    if (s.connection) {
        return t("sessions.bulk.skip.remote", { connection: s.connection });
    }
    if (!s.shown || !s.blockid) {
        return t("sessions.bulk.skip.notInPane");
    }
    if (s.reason === "olderversion") {
        return t("sessions.bulk.skip.olderVersion");
    }
    return "";
}

export function bulkSkip(action: BulkAction, s: DurableSession, command?: BulkCommand): string {
    switch (action) {
        case "end":
            return s.canend ? "" : t("sessions.bulk.skip.cannotEnd");
        case "restart":
            return agentSkip(s);
        case "send": {
            const skip = agentSkip(s);
            if (skip) {
                return skip;
            }
            if (command != null && command.actions[s.agent] == null) {
                return t("sessions.bulk.skip.noCommand", { agent: agentLabel(s), command: bulkCommandLabel(command) });
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
    // Ending reaches every session: the note says what it stops (FR-SHELL-061).
    if (action === "end") {
        return endRunningNote(s);
    }
    if (!s.agent) {
        return "";
    }
    const interrupt = action === "send" && command?.id === InterruptAction;
    if (s.agentstate === "working" && !interrupt) {
        return t("sessions.bulk.busyWorking");
    }
    if (s.agentstate === "waiting") {
        return t("sessions.bulk.busyWaiting");
    }
    return "";
}

// A count with its words: key.one or key.other, with {count}.
function plural(n: number, key: string): string {
    return t(n === 1 ? `${key}.one` : `${key}.other`, { count: n });
}

export type BulkConfirmText = { title: string; subtitle: string; confirm: string; running: string };

export function bulkConfirmText(action: BulkAction, items: BulkItem[], command?: BulkCommand): BulkConfirmText {
    const n = items.filter((i) => !i.skip).length;
    const skipped = items.length - n;
    const skipText = skipped > 0 ? ` ${plural(skipped, "sessions.bulk.leftOut")}` : "";
    const sessions = plural(n, "sessions.count.sessions");
    const agents = plural(n, "sessions.count.agents");
    switch (action) {
        case "end":
            return {
                title: t("sessions.bulk.end.title", { sessions }),
                subtitle: `${t("sessions.bulk.end.subtitle")}${skipText}`,
                confirm: t("sessions.bulk.end.confirm", { sessions }),
                running: t("sessions.bulk.end.running"),
            };
        case "restart":
            return {
                title: t("sessions.bulk.restart.title", { agents }),
                subtitle: `${t("sessions.bulk.restart.subtitle")}${skipText}`,
                confirm: t("sessions.bulk.restart.confirm", { agents }),
                running: t("sessions.bulk.restart.running"),
            };
        case "send":
            return {
                title: t("sessions.bulk.send.title", {
                    command: command != null ? bulkCommandLabel(command) : t("sessions.bulk.send.aCommand"),
                    agents,
                }),
                subtitle:
                    (command?.id === InterruptAction
                        ? t("sessions.bulk.send.subtitleInterrupt")
                        : t("sessions.bulk.send.subtitle")) + skipText,
                confirm: t("sessions.bulk.send.confirm", { agents }),
                running: t("sessions.bulk.send.running"),
            };
    }
}

export function restartResult(id: string, out: AgentRestartOutcome): BulkResult {
    if (out == null) {
        return { id, kind: "failed", message: t("sessions.bulk.unreachable") };
    }
    switch (out.status) {
        case "restarted":
            return { id, kind: "done", message: out.message };
        case "agentbusy":
        case "busy":
            return { id, kind: "skipped", message: out.message };
    }
    return { id, kind: "failed", message: out.message || t("sessions.bulk.notRestarted") };
}

export function sendResult(id: string, out: AgentInputResult): BulkResult {
    if (out == null) {
        return { id, kind: "failed", message: t("sessions.bulk.unreachable") };
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
    return { id, kind: "failed", message: out.message || t("sessions.bulk.nothingTyped") };
}

export function endResult(id: string, res: SessionEndResult): BulkResult {
    if (res?.pending) {
        return { id, kind: "done", message: t("sessions.bulk.endsLater") };
    }
    return { id, kind: "done", message: t("sessions.bulk.ended") };
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
                    result.message += ` ${t("sessions.bulk.keptOwnMode", { agent: agentLabel(s) })}`;
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
    return { id: s.id, kind: "failed", message: t("sessions.bulk.unknownAction") };
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

export function bulkKindLabel(kind: BulkResultKind): string {
    return t(`sessions.bulk.kind.${kind}`);
}

export function bulkSummary(
    action: BulkAction,
    results: BulkResult[]
): { title: string; detail: string; tone: BulkResultKind } {
    const done = results.filter((r) => r.kind === "done").length;
    const skipped = results.filter((r) => r.kind === "skipped").length;
    const failed = results.filter((r) => r.kind === "failed").length;
    const parts = [];
    if (skipped > 0) {
        parts.push(t("sessions.bulk.skippedCount", { count: skipped }));
    }
    if (failed > 0) {
        parts.push(t("sessions.bulk.failedCount", { count: failed }));
    }
    return {
        title: t(`sessions.bulk.summary.${action}`, {
            done,
            sessions: plural(results.length, "sessions.count.sessions"),
        }),
        detail: parts.join(" · "),
        tone: failed > 0 ? "failed" : skipped > 0 ? "skipped" : "done",
    };
}

// The summary toast of a finished run (#439): only when its results dialog is gone (the view closed, or its sessions
// all went away), since an open dialog already shows every result; null when there is nothing to report.
export function unseenBulkSummary(
    action: BulkAction,
    results: BulkResult[],
    dialogOpen: boolean
): { title: string; detail: string; tone: BulkResultKind } {
    if (dialogOpen || results.length === 0) {
        return null;
    }
    return bulkSummary(action, results);
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
