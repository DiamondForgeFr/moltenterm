// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Durable sessions (FR-SHELL-020, DS-SHELL-021): every durable terminal still running, local or SSH. wavesrv builds
// the list (pkg/molten/sessions) and publishes it when it changes; the Sessions view, the rail's badge and Welcome
// back (#157) read it. Kept apart from the components so the rules can be tested without the app.

import { agentStateLabel } from "../agent-state-model";
import { t } from "../i18n/i18n";

export const MoltentermSessionsView = "molten-sessions";

// must match pkg/molten/durablesession.go
export const DurableSessionsRoute = "molten:sessions";
export const DurableSessionsEvent = "molten:sessions";
export const DurableSessionsListCommand = "moltensessionslist";
export const DurableSessionsShowCommand = "moltensessionsshow";
export const DurableSessionsEndCommand = "moltensessionsend";
export const DurableSessionsCleanupCommand = "moltensessionscleanup";
export const DurableSessionsReconnectCommand = "moltensessionsreconnect";
export const FocusBlockMetaKey = "molten:focusblock";

export type SessionConnState = "connected" | "reconnecting" | "disconnected";
export type SessionReason = "detached" | "panegone" | "replaced" | "olderversion" | "ending";

// must match DurableSession in pkg/molten/durablesession.go
export type DurableSession = {
    id: string;
    shortid: string;
    // "" is local.
    connection: string;
    connstate: SessionConnState;
    connerror?: string;
    agent?: string;
    agentname?: string;
    agentstate?: string;
    command?: string;
    folder?: string;
    worktree?: { path: string; branch?: string };
    startedat?: number;
    lastoutputat?: number;
    workspaceid?: string;
    workspacename?: string;
    workspacecolor?: string;
    workspaceorder: number;
    tabid?: string;
    tabname?: string;
    blockid?: string;
    shown: boolean;
    reason?: SessionReason;
    canshow: boolean;
    canend: boolean;
};

export type DurableSessionsData = {
    sessions: DurableSession[];
    runningagents: number;
    version: number;
};

export type SessionLocation = { workspaceid: string; tabid: string; blockid: string; created?: boolean };
export type SessionsCleanupResult = { ended: string[]; skipped: string[]; failed?: string[] };
export type SessionEndResult = { pending?: boolean };

export const EmptySessions: DurableSessionsData = { sessions: [], runningagents: 0, version: 0 };

// A snapshot and the events race at start: the newer version wins.
export function applySessions(current: DurableSessionsData, next: DurableSessionsData): DurableSessionsData {
    if (next == null) {
        return current;
    }
    if (current != null && next.version <= current.version) {
        return current;
    }
    return { ...next, sessions: next.sessions ?? [] };
}

// sessions.reason.<reason>.label and .title.
const Reasons = ["detached", "panegone", "replaced", "olderversion", "ending"];

export function reasonLabel(reason: string): string {
    return Reasons.includes(reason) ? t(`sessions.reason.${reason}.label`) : (reason ?? "");
}

export function reasonTitle(reason: string): string {
    return Reasons.includes(reason) ? t(`sessions.reason.${reason}.title`) : "";
}

// Agents first by how much they need the user, then the commands.
const Urgency: Record<string, number> = { waiting: 5, error: 4, working: 3, done: 2, idle: 1 };

export function sessionUrgency(s: DurableSession): number {
    if (!s.agent) {
        return 0;
    }
    return Urgency[s.agentstate] ?? 1;
}

// Then the newest first: by start, not by the last output, which would make rows jump while terminals print.
export function sortSessions(list: DurableSession[]): DurableSession[] {
    return [...list].sort(
        (a, b) =>
            sessionUrgency(b) - sessionUrgency(a) || (b.startedat ?? 0) - (a.startedat ?? 0) || a.id.localeCompare(b.id)
    );
}

export type SessionGroup = {
    // "hidden" for the sessions no pane shows, else the workspace id.
    id: string;
    title: string;
    color?: string;
    current?: boolean;
    sessions: DurableSession[];
};

export const HiddenGroupId = "hidden";

// "Not in a pane" first when it has rows (they need an action), then one group per workspace in the rail's order.
export function groupSessions(list: DurableSession[], currentWorkspaceId: string): SessionGroup[] {
    const hidden = (list ?? []).filter((s) => !s.shown);
    const byWs = new Map<string, SessionGroup & { order: number }>();
    for (const s of list ?? []) {
        if (!s.shown) {
            continue;
        }
        const key = s.workspaceid ?? "";
        let group = byWs.get(key);
        if (group == null) {
            group = {
                id: key,
                title: s.workspacename || t("sessions.workspace"),
                color: s.workspacecolor,
                current: key === currentWorkspaceId,
                sessions: [],
                order: s.workspaceorder ?? 0,
            };
            byWs.set(key, group);
        }
        group.sessions.push(s);
    }
    const rtn: SessionGroup[] = [];
    if (hidden.length > 0) {
        rtn.push({ id: HiddenGroupId, title: t("sessions.notInPaneTitle"), sessions: sortSessions(hidden) });
    }
    const groups = [...byWs.values()].sort((a, b) => a.order - b.order);
    for (const { order: _order, ...group } of groups) {
        rtn.push({ ...group, sessions: sortSessions(group.sessions) });
    }
    return rtn;
}

// The rows in the order the keyboard walks them, across groups.
export function flattenGroups(groups: SessionGroup[]): string[] {
    return groups.flatMap((g) => g.sessions.map((s) => s.id));
}

export const PageStep = 10;

export function moveSelection(order: string[], current: string, key: string): string {
    if (order.length === 0) {
        return null;
    }
    const idx = order.indexOf(current);
    const last = order.length - 1;
    let next: number;
    switch (key) {
        case "ArrowDown":
            next = idx < 0 ? 0 : Math.min(idx + 1, last);
            break;
        case "ArrowUp":
            next = idx < 0 ? 0 : Math.max(idx - 1, 0);
            break;
        case "Home":
            next = 0;
            break;
        case "End":
            next = last;
            break;
        case "PageDown":
            next = idx < 0 ? 0 : Math.min(idx + PageStep, last);
            break;
        case "PageUp":
            next = idx < 0 ? 0 : Math.max(idx - PageStep, 0);
            break;
        default:
            return current;
    }
    return order[next];
}

// The row to focus once a row is gone: the one that took its place, else the one above.
export function nextSelection(before: string[], after: string[], gone: string): string {
    if (after.includes(gone)) {
        return gone;
    }
    const idx = before.indexOf(gone);
    for (let i = idx + 1; i < before.length; i++) {
        if (after.includes(before[i])) {
            return before[i];
        }
    }
    for (let i = idx - 1; i >= 0; i--) {
        if (after.includes(before[i])) {
            return before[i];
        }
    }
    return after[0] ?? null;
}

const AgeNowSec = 5;

function ageSeconds(fromMs: number, nowMs: number): number {
    return Math.max(0, Math.floor((nowMs - fromMs) / 1000));
}

function isNow(fromMs: number, nowMs: number): boolean {
    return !!fromMs && ageSeconds(fromMs, nowMs) < AgeNowSec;
}

export function formatAge(fromMs: number, nowMs: number): string {
    if (!fromMs) {
        return "";
    }
    const sec = ageSeconds(fromMs, nowMs);
    if (sec < AgeNowSec) {
        return t("sessions.age.now");
    }
    if (sec < 60) {
        return t("sessions.age.seconds", { count: sec });
    }
    const min = Math.floor(sec / 60);
    if (min < 60) {
        return t("sessions.age.minutes", { count: min });
    }
    const hours = Math.floor(min / 60);
    if (hours < 24) {
        const rest = min % 60;
        return rest === 0
            ? t("sessions.age.hours", { count: hours })
            : t("sessions.age.hoursMinutes", { hours, minutes: rest });
    }
    return t("sessions.age.days", { count: Math.floor(hours / 24) });
}

export function outputText(s: DurableSession, nowMs: number): string {
    if (!s.lastoutputat) {
        return "";
    }
    if (isNow(s.lastoutputat, nowMs)) {
        return t("sessions.outputNow");
    }
    return t("sessions.outputAgo", { age: formatAge(s.lastoutputat, nowMs) });
}

export function tildePath(path: string, home: string): string {
    if (!path || !home) {
        return path ?? "";
    }
    const h = home.replace(/[/\\]+$/, "");
    if (path === h) {
        return "~";
    }
    if (path.startsWith(h + "/")) {
        return "~" + path.slice(h.length);
    }
    return path;
}

export function middleTruncate(text: string, max: number): string {
    if (!text || text.length <= max || max < 5) {
        return text ?? "";
    }
    const keep = max - 1;
    const head = Math.ceil(keep / 2);
    return text.slice(0, head) + "…" + text.slice(text.length - (keep - head));
}

// The folder as the row shows it: ~ for the home of a local session.
export function displayFolder(s: DurableSession, home: string): string {
    if (!s.folder) {
        return "";
    }
    return s.connection ? s.folder : tildePath(s.folder, home);
}

export function sessionWhat(s: DurableSession): string {
    return s.agentname || s.agent || s.command || t("sessions.thisSession");
}

// The Sessions table (FR-SHELL-058, DS-SHELL-100): a row is named by its place (the tab when it has a name of its
// own, else the folder), and its folder and agent get their own columns, so a shell at its prompt no longer reads
// "zsh at prompt" on every row.
const AtPromptSuffix = " at prompt";

// wavesrv names only the shell when its integration has said nothing yet (a shell started without its rc files).
const BareShell = /^(zsh|bash|fish|sh|dash|ksh|tcsh|nu|pwsh|powershell|cmd|shell)$/;

export function atPrompt(s: DurableSession): boolean {
    const cmd = s.command ?? "";
    return !s.agent && (cmd.endsWith(AtPromptSuffix) || BareShell.test(cmd));
}

// What ending a session loses, for the confirmations listing several (FR-SHELL-061, DS-SHELL-108): their rows already
// name the agent or the command each session runs, so the note only says what a working or waiting agent loses.
export function endRunningNote(s: DurableSession): string {
    if (s.agent && s.agentstate === "working") {
        return t("sessions.endNote.working");
    }
    if (s.agent && s.agentstate === "waiting") {
        return t("sessions.endNote.waiting");
    }
    return "";
}

// The program running when it is neither the agent nor the shell at its prompt ("npm run dev").
export function runningCommand(s: DurableSession): string {
    if (!s.command || atPrompt(s)) {
        return "";
    }
    if (s.agent && (s.command === s.agentname || s.command === s.agent)) {
        return "";
    }
    return s.command;
}

function baseName(path: string): string {
    const parts = path.split(/[/\\]+/).filter((p) => !!p);
    return parts[parts.length - 1] ?? "";
}

const GenericTabName = /^(t|tab|terminal|shell|zsh|bash|fish|sh|new tab)\s*\d*$/i;

export function sessionName(s: DurableSession, home: string): string {
    const tab = (s.tabname ?? "").trim();
    if (tab && !GenericTabName.test(tab)) {
        return tab;
    }
    const folder = displayFolder(s, home);
    if (folder === "~") {
        return t("sessions.home");
    }
    return baseName(folder) || runningCommand(s) || t("sessions.terminal");
}

export type AgentCell = { label: string; kind: "agent" | "command" | "shell" };

export function agentCell(s: DurableSession): AgentCell {
    if (s.agent) {
        return { label: s.agentname || s.agent, kind: "agent" };
    }
    const cmd = runningCommand(s);
    if (cmd) {
        return { label: cmd, kind: "command" };
    }
    return { label: t("sessions.shell"), kind: "shell" };
}

// Last active: the last output, else the start.
export function lastActive(s: DurableSession, nowMs: number): string {
    const at = s.lastoutputat || s.startedat;
    if (!at) {
        return "";
    }
    if (isNow(at, nowMs)) {
        return t("sessions.now");
    }
    return t("sessions.ago", { age: formatAge(at, nowMs) });
}

export type ConnChip = { label: string; state: SessionConnState; title: string };

export function connChip(s: DurableSession): ConnChip {
    if (!s.connection) {
        return { label: t("sessions.local"), state: s.connstate, title: connStateLabel(s) };
    }
    return { label: s.connection, state: s.connstate, title: connStateLabel(s) };
}

export function connStateLabel(s: DurableSession): string {
    const where = s.connection || t("sessions.thisComputer");
    switch (s.connstate) {
        case "connected":
            return t("sessions.conn.connected", { where });
        case "reconnecting":
            return t("sessions.conn.reconnecting", { where });
    }
    const err = s.connerror ? `\n${s.connerror}` : "";
    return `${t("sessions.conn.disconnected", { where })}${err}`;
}

export function canReconnect(s: DurableSession): boolean {
    return s.connstate === "disconnected" && s.reason !== "olderversion" && s.reason !== "ending";
}

export function showLabel(s: DurableSession): string {
    return s.shown ? t("sessions.show") : t("sessions.openInPane");
}

export function placeText(s: DurableSession): string {
    if (!s.shown) {
        return t("sessions.notInPane");
    }
    return s.workspacename ? `${s.workspacename}${s.tabname ? ` › ${s.tabname}` : ""}` : "";
}

export type ConfirmText = { title: string; subtitle: string; warning?: string; confirm: string };

export function endConfirmText(s: DurableSession, home: string, nowMs: number): ConfirmText {
    const folder = displayFolder(s, home);
    const what = sessionWhat(s);
    const up = formatAge(s.startedat, nowMs);
    const subtitle = [placeText(s), s.connection || t("sessions.local"), up ? t("sessions.up", { age: up }) : ""]
        .filter((p) => !!p)
        .join(" · ");
    let warning: string;
    if (s.agent && s.agentstate === "working") {
        warning = t("sessions.end.warningWorking", { what });
    } else if (s.agent && s.agentstate === "waiting") {
        warning = t("sessions.end.warningWaiting", { what });
    }
    return {
        title: folder ? t("sessions.end.titleIn", { what, folder }) : t("sessions.end.title", { what }),
        subtitle,
        warning,
        confirm: t("sessions.end.confirm"),
    };
}

// A count with its words: key.one or key.other, with {count}.
function plural(n: number, key: string): string {
    return t(n === 1 ? `${key}.one` : `${key}.other`, { count: n });
}

export function cleanupConfirmText(list: DurableSession[]): ConfirmText {
    const n = list.length;
    return {
        title: t("sessions.cleanup.title", { sessions: plural(n, "sessions.count.sessions") }),
        subtitle: t("sessions.cleanup.subtitle"),
        confirm: t("sessions.cleanup.confirm", { sessions: plural(n, "sessions.count.sessions") }),
    };
}

export function cleanupResultText(res: SessionsCleanupResult): string {
    const parts = [t("sessions.cleanup.ended", { count: res?.ended?.length ?? 0 })];
    if (res?.skipped?.length) {
        parts.push(t("sessions.cleanup.skipped", { count: res.skipped.length }));
    }
    if (res?.failed?.length) {
        parts.push(t("sessions.cleanup.failed", { count: res.failed.length }));
    }
    return parts.join(" · ");
}

export type RailBadge = { count: number; tone: "waiting" | "error" | "accent"; label: string };

export function railBadge(data: DurableSessionsData): RailBadge {
    const list = data?.sessions ?? [];
    const agents = list.filter((s) => !!s.agent);
    const waiting = agents.filter((s) => s.agentstate === "waiting").length;
    const errors = agents.filter((s) => s.agentstate === "error").length;
    const tone = waiting > 0 ? "waiting" : errors > 0 ? "error" : "accent";
    let label = t("sessions.title");
    if (agents.length > 0) {
        label += ` · ${t("sessions.badge.running", { what: plural(agents.length, "sessions.count.agents") })}`;
        if (waiting > 0) {
            label += `, ${t("sessions.badge.waiting", { count: waiting })}`;
        }
        if (errors > 0) {
            label += `, ${t("sessions.badge.errors", { count: errors })}`;
        }
    } else if (list.length > 0) {
        label += ` · ${t("sessions.badge.running", { what: plural(list.length, "sessions.count.sessions") })}`;
    }
    return { count: agents.length, tone, label };
}

export function sessionsSummary(data: DurableSessionsData): string {
    const n = data?.sessions?.length ?? 0;
    if (n === 0) {
        return t("sessions.noneRunning");
    }
    const hidden = data.sessions.filter((s) => !s.shown).length;
    const parts = [plural(n, "sessions.count.sessions"), plural(data.runningagents ?? 0, "sessions.count.agents")];
    if (hidden > 0) {
        parts.push(t("sessions.hiddenCount", { count: hidden }));
    }
    return parts.join(" · ");
}

// What a screen reader reads for a row.
export function rowAriaLabel(s: DurableSession, home: string, nowMs: number): string {
    const parts = [sessionWhat(s)];
    if (s.agent && s.agentstate) {
        parts.push(agentStateLabel(s.agentstate));
    }
    if (s.agent && s.command && s.command !== s.agentname) {
        parts.push(s.command);
    }
    parts.push(
        s.connection ? t("sessions.aria.on", { connection: s.connection, state: s.connstate }) : t("sessions.local")
    );
    const folder = displayFolder(s, home);
    if (folder) {
        parts.push(t("sessions.aria.in", { folder }));
    }
    if (s.worktree?.branch) {
        parts.push(t("sessions.aria.branch", { branch: s.worktree.branch }));
    }
    if (s.startedat) {
        parts.push(t("sessions.up", { age: formatAge(s.startedat, nowMs) }));
    }
    parts.push(outputText(s, nowMs));
    if (s.reason) {
        parts.push(reasonLabel(s.reason));
    }
    parts.push(placeText(s));
    return parts.filter((p) => !!p).join(", ");
}
