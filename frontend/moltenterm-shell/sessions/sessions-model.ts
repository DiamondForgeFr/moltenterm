// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Durable sessions (FR-SHELL-020, DS-SHELL-021): every durable terminal still running, local or SSH. wavesrv builds
// the list (pkg/molten/sessions) and publishes it when it changes; the Sessions view, the rail's badge and Welcome
// back (#157) read it. Kept apart from the components so the rules can be tested without the app.

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

const ReasonLabels: Record<string, string> = {
    detached: "detached",
    panegone: "pane closed",
    replaced: "replaced in its pane",
    olderversion: "older version",
    ending: "ending",
};

const ReasonTitles: Record<string, string> = {
    detached: "Detached from its pane: it keeps running with no pane showing it.",
    panegone: "Its pane was closed while MoltenTerm was stopping: it kept running.",
    replaced: "Another session took its pane: it kept running.",
    olderversion: "Started by an older MoltenTerm: it can only be ended.",
    ending: "Being ended: its host was unreachable, it ends once the host is back.",
};

export function reasonLabel(reason: string): string {
    return ReasonLabels[reason] ?? reason ?? "";
}

export function reasonTitle(reason: string): string {
    return ReasonTitles[reason] ?? "";
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
                title: s.workspacename || "Workspace",
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
        rtn.push({ id: HiddenGroupId, title: "Not in a pane", sessions: sortSessions(hidden) });
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

export function formatAge(fromMs: number, nowMs: number): string {
    if (!fromMs) {
        return "";
    }
    const sec = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
    if (sec < 5) {
        return "now";
    }
    if (sec < 60) {
        return `${sec} s`;
    }
    const min = Math.floor(sec / 60);
    if (min < 60) {
        return `${min} min`;
    }
    const hours = Math.floor(min / 60);
    if (hours < 24) {
        const rest = min % 60;
        return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
    }
    return `${Math.floor(hours / 24)} d`;
}

export function outputText(s: DurableSession, nowMs: number): string {
    const age = formatAge(s.lastoutputat, nowMs);
    if (!age) {
        return "";
    }
    return age === "now" ? "output just now" : `output ${age} ago`;
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
    return s.agentname || s.agent || s.command || "this session";
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
        return "Home";
    }
    return baseName(folder) || runningCommand(s) || "Terminal";
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
    return { label: "Shell", kind: "shell" };
}

// Last active: the last output, else the start.
export function lastActive(s: DurableSession, nowMs: number): string {
    const at = s.lastoutputat || s.startedat;
    const age = formatAge(at, nowMs);
    if (!age) {
        return "";
    }
    return age === "now" ? "now" : `${age} ago`;
}

export type ConnChip = { label: string; state: SessionConnState; title: string };

export function connChip(s: DurableSession): ConnChip {
    if (!s.connection) {
        return { label: "local", state: s.connstate, title: connStateLabel(s) };
    }
    return { label: s.connection, state: s.connstate, title: connStateLabel(s) };
}

export function connStateLabel(s: DurableSession): string {
    const where = s.connection || "This Mac";
    switch (s.connstate) {
        case "connected":
            return `${where}: connected`;
        case "reconnecting":
            return `${where}: reconnecting…`;
    }
    const err = s.connerror ? `\n${s.connerror}` : "";
    return `${where}: disconnected${err}`;
}

export function canReconnect(s: DurableSession): boolean {
    return s.connstate === "disconnected" && s.reason !== "olderversion" && s.reason !== "ending";
}

export function showLabel(s: DurableSession): string {
    return s.shown ? "Show" : "Open in a pane";
}

export function placeText(s: DurableSession): string {
    if (!s.shown) {
        return "not in a pane";
    }
    return s.workspacename ? `${s.workspacename}${s.tabname ? ` › ${s.tabname}` : ""}` : "";
}

export type ConfirmText = { title: string; subtitle: string; warning?: string; confirm: string };

export function endConfirmText(s: DurableSession, home: string, nowMs: number): ConfirmText {
    const folder = displayFolder(s, home);
    const what = sessionWhat(s);
    const up = formatAge(s.startedat, nowMs);
    const subtitle = [placeText(s), s.connection || "local", up ? `up ${up}` : ""].filter((p) => !!p).join(" · ");
    let warning: string;
    if (s.agent && s.agentstate === "working") {
        warning = `${what} is working: its current task stops.`;
    } else if (s.agent && s.agentstate === "waiting") {
        warning = `${what} is waiting for you: what it was asking is lost.`;
    }
    return {
        title: folder ? `End ${what} in ${folder}?` : `End ${what}?`,
        subtitle,
        warning,
        confirm: "End session",
    };
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function cleanupConfirmText(list: DurableSession[]): ConfirmText {
    const n = list.length;
    return {
        title: `End ${plural(n, "session")} not in a pane?`,
        subtitle: "They run with no pane showing them. Ending them stops what runs in them.",
        confirm: `End ${plural(n, "session")}`,
    };
}

export function cleanupResultText(res: SessionsCleanupResult): string {
    const parts = [`Ended ${res?.ended?.length ?? 0}`];
    if (res?.skipped?.length) {
        parts.push(`${res.skipped.length} skipped (shown in a pane or gone since)`);
    }
    if (res?.failed?.length) {
        parts.push(`${res.failed.length} ending once their host is back`);
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
    let label = "Sessions";
    if (agents.length > 0) {
        label += ` · ${plural(agents.length, "agent")} running`;
        if (waiting > 0) {
            label += `, ${waiting} waiting`;
        }
        if (errors > 0) {
            label += `, ${errors} with an error`;
        }
    } else if (list.length > 0) {
        label += ` · ${plural(list.length, "session")} running`;
    }
    return { count: agents.length, tone, label };
}

export function sessionsSummary(data: DurableSessionsData): string {
    const n = data?.sessions?.length ?? 0;
    if (n === 0) {
        return "No session running";
    }
    const hidden = data.sessions.filter((s) => !s.shown).length;
    const parts = [plural(n, "session"), `${plural(data.runningagents ?? 0, "agent")}`];
    if (hidden > 0) {
        parts.push(`${hidden} not in a pane`);
    }
    return parts.join(" · ");
}

// What a screen reader reads for a row.
export function rowAriaLabel(s: DurableSession, home: string, nowMs: number): string {
    const parts = [sessionWhat(s)];
    if (s.agent && s.agentstate) {
        parts.push(s.agentstate === "waiting" ? "waiting for you" : s.agentstate);
    }
    if (s.agent && s.command && s.command !== s.agentname) {
        parts.push(s.command);
    }
    parts.push(s.connection ? `on ${s.connection}, ${s.connstate}` : "local");
    const folder = displayFolder(s, home);
    if (folder) {
        parts.push(`in ${folder}`);
    }
    if (s.worktree?.branch) {
        parts.push(`branch ${s.worktree.branch}`);
    }
    if (s.startedat) {
        parts.push(`up ${formatAge(s.startedat, nowMs)}`);
    }
    parts.push(outputText(s, nowMs));
    if (s.reason) {
        parts.push(reasonLabel(s.reason));
    }
    parts.push(placeText(s));
    return parts.filter((p) => !!p).join(", ");
}
