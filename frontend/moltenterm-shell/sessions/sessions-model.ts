// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Durable sessions (FR-SHELL-020, DS-SHELL-021): every durable terminal still running, local or SSH. wavesrv builds
// the list (pkg/molten/sessions) and publishes it when it changes; the Sessions view, the rail's badge and Welcome
// back (#157) read it. Kept apart from the components so the rules can be tested without the app.

import { agentStateLabel } from "../agent-state-model";
import { t } from "../i18n/i18n";
import { workspaceShownName } from "../workspace-default-name";

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

// must match SessionOrigin and SessionContext in pkg/molten/durablesession.go (#933)
export type SessionOriginKind = "rebase" | "restart" | "investigate" | "batch" | "review";
export type SessionOrigin = { kind: SessionOriginKind; repo?: string; number?: number; at?: number };
export type SessionPrState = "draft" | "open" | "merged" | "closed";
export type SessionContext = {
    repo?: string;
    branch?: string;
    ticket?: number;
    pr?: number;
    prtitle?: string;
    prurl?: string;
    prstate?: SessionPrState;
};

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
    firstname?: string;
    model?: string;
    modelname?: string;
    effort?: string;
    origin?: SessionOrigin;
    context?: SessionContext;
    parentid?: string;
    command?: string;
    folder?: string;
    worktree?: { path: string; branch?: string; main?: string };
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
    // Sub-sessions (#933): a session's depth under the session that handed it work; absent is 0.
    depths?: Record<string, number>;
};

export const HiddenGroupId = "hidden";

// A sub-session's parent when it is listed (never itself).
function listedParent(s: DurableSession, ids: Set<string>): string {
    return s.parentid && s.parentid !== s.id && ids.has(s.parentid) ? s.parentid : null;
}

// Sub-sessions follow their parent, in the parent's group, one level deeper (FR-SHELL-058, #933). A session whose
// parents loop back to it is shown at the top level.
export function nestGroup(group: SessionGroup, all: DurableSession[]): SessionGroup {
    const ids = new Set(all.map((s) => s.id));
    const children = new Map<string, DurableSession[]>();
    for (const s of all) {
        const parent = listedParent(s, ids);
        if (parent != null) {
            children.set(parent, [...(children.get(parent) ?? []), s]);
        }
    }
    if (children.size === 0) {
        return group;
    }
    const sessions: DurableSession[] = [];
    const depths: Record<string, number> = {};
    const seen = new Set<string>();
    const visit = (s: DurableSession, depth: number) => {
        if (seen.has(s.id)) {
            return;
        }
        seen.add(s.id);
        sessions.push(s);
        if (depth > 0) {
            depths[s.id] = depth;
        }
        for (const child of sortSessions(children.get(s.id) ?? [])) {
            visit(child, depth + 1);
        }
    };
    group.sessions.forEach((s) => visit(s, 0));
    return { ...group, sessions, depths };
}

// "Not in a pane" first when it has rows (they need an action), then one group per workspace in the rail's order.
export function groupSessions(list: DurableSession[], currentWorkspaceId: string): SessionGroup[] {
    const all = list ?? [];
    const ids = new Set(all.map((s) => s.id));
    const byId = new Map(all.map((s) => [s.id, s]));
    // A sub-session goes where its top parent goes; a loop of parents leaves its sessions at the top.
    const isRoot = (s: DurableSession) => {
        const seen = new Set<string>([s.id]);
        let cur = s;
        for (;;) {
            const parent = listedParent(cur, ids);
            if (parent == null) {
                return cur === s;
            }
            if (seen.has(parent)) {
                return true;
            }
            seen.add(parent);
            cur = byId.get(parent);
        }
    };
    const roots = all.filter(isRoot);
    const nest = (group: SessionGroup) => nestGroup(group, all);
    const hidden = roots.filter((s) => !s.shown);
    const byWs = new Map<string, SessionGroup & { order: number }>();
    for (const s of roots) {
        if (!s.shown) {
            continue;
        }
        const key = s.workspaceid ?? "";
        let group = byWs.get(key);
        if (group == null) {
            group = {
                id: key,
                title: workspaceShownName(s.workspacename, t) || t("sessions.workspace"),
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
        rtn.push(nest({ id: HiddenGroupId, title: t("sessions.notInPaneTitle"), sessions: sortSessions(hidden) }));
    }
    const groups = [...byWs.values()].sort((a, b) => a.order - b.order);
    for (const { order: _order, ...group } of groups) {
        rtn.push(nest({ ...group, sessions: sortSessions(group.sessions) }));
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
    const workspace = workspaceShownName(s.workspacename, t);
    return workspace ? `${workspace}${s.tabname ? ` › ${s.tabname}` : ""}` : "";
}

export type ConfirmText = { title: string; subtitle: string; warning?: string; confirm: string };

export function endConfirmText(s: DurableSession, home: string, nowMs: number): ConfirmText {
    const folder = displayFolder(s, home);
    // The confirmation names the session by its agent's first name when it has one (#933).
    const what = s.firstname ? t("sessions.namedWhat", { name: s.firstname, what: sessionWhat(s) }) : sessionWhat(s);
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

// Who, what, from where (FR-SHELL-058, #933).

// The name a row leads with: its agent's first name, else its place.
export function rowName(s: DurableSession, home: string): string {
    return s.firstname || sessionName(s, home);
}

const OriginKinds: SessionOriginKind[] = ["rebase", "restart", "investigate", "batch", "review"];

function knownOrigin(s: DurableSession): SessionOrigin {
    return s.origin != null && OriginKinds.includes(s.origin.kind) ? s.origin : null;
}

// Direct: the developer's own terminal or agent; else the MoltenTerm action that started it.
export function sessionKind(s: DurableSession): "direct" | "started" {
    return knownOrigin(s) != null ? "started" : "direct";
}

export function sessionKindLabel(s: DurableSession): string {
    const origin = knownOrigin(s);
    return origin != null ? t(`sessions.kind.${origin.kind}`) : t("sessions.kind.direct");
}

// The surface each MoltenTerm action is started from.
const OriginSurfaces: Record<SessionOriginKind, string> = {
    investigate: "reviews",
    rebase: "reviews",
    restart: "reviewTab",
    batch: "mergeQueue",
    review: "reviewPanel",
};

// Where the session was started: the surface of a MoltenTerm action, else the workspace and tab it lives in.
export function startedFrom(s: DurableSession): string {
    const origin = knownOrigin(s);
    if (origin != null) {
        return t(`sessions.from.${OriginSurfaces[origin.kind]}`);
    }
    return placeText(s);
}

export type ContextLink = { kind: "ticket" | "pr"; label: string; url?: string; state?: SessionPrState; title: string };

const PrStates: SessionPrState[] = ["draft", "open", "merged", "closed"];
const RepoName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function prStateLabel(state: string): string {
    return PrStates.includes(state as SessionPrState) ? t(`sessions.prState.${state}`) : "";
}

// The ticket and the PR the session works on, with their links when the repository is known.
export function contextLinks(s: DurableSession): ContextLink[] {
    const ctx = s.context;
    if (ctx == null) {
        return [];
    }
    const repo = RepoName.test(ctx.repo ?? "") ? ctx.repo : "";
    const rtn: ContextLink[] = [];
    if (ctx.ticket > 0 && ctx.ticket !== ctx.pr) {
        rtn.push({
            kind: "ticket",
            label: t("sessions.context.ticket", { number: ctx.ticket }),
            url: repo ? `https://github.com/${repo}/issues/${ctx.ticket}` : undefined,
            title: t("sessions.context.ticketTitle", { number: ctx.ticket }),
        });
    }
    if (ctx.pr > 0) {
        const state = PrStates.includes(ctx.prstate) ? ctx.prstate : undefined;
        const title = [ctx.prtitle, state ? prStateLabel(state) : t("sessions.context.prStateUnknown")]
            .filter((p) => !!p)
            .join(" · ");
        rtn.push({
            kind: "pr",
            label: t("sessions.context.pr", { number: ctx.pr }),
            url: ctx.prurl || (repo ? `https://github.com/${repo}/pull/${ctx.pr}` : undefined),
            state,
            title,
        });
    }
    return rtn;
}

// "Opus 5.5 · effort high", as the agent last reported them; "" when it said nothing.
export function modelText(s: DurableSession): string {
    if (!s.agent) {
        return "";
    }
    const model = s.modelname || s.model;
    const effort = s.effort ? t("sessions.effort", { effort: s.effort }) : "";
    return [model, effort].filter((p) => !!p).join(" · ");
}

// What the worktree column shows: the worktree's branch (or its folder's name), else the folder.
export function placeColumn(s: DurableSession, home: string): { label: string; title: string; copy: string } {
    const wt = s.worktree;
    if (wt != null) {
        const label = wt.branch || baseName(wt.path) || wt.path;
        const title = wt.branch
            ? t("sessions.view.worktreeOn", { path: wt.path, branch: wt.branch })
            : t("sessions.view.worktree", { path: wt.path });
        return { label, title, copy: wt.path };
    }
    const folder = displayFolder(s, home);
    return { label: folder, title: s.folder ?? "", copy: s.folder ?? "" };
}

function sameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// When it started: the time today, else the date and the time.
export function startedAtText(s: DurableSession, nowMs: number, locale?: string): string {
    if (!s.startedat) {
        return "";
    }
    const at = new Date(s.startedat);
    const time = at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    if (sameDay(at, new Date(nowMs))) {
        return time;
    }
    return `${at.toLocaleDateString(locale, { day: "numeric", month: "short" })} ${time}`;
}

// The activity cell's hover: started at, running for, last output.
export function activityTitle(s: DurableSession, nowMs: number, locale?: string): string {
    const lines: string[] = [];
    const started = startedAtText(s, nowMs, locale);
    if (started) {
        lines.push(t("sessions.activity.started", { at: started }));
        lines.push(t("sessions.activity.running", { age: formatAge(s.startedat, nowMs) }));
    }
    const output = outputText(s, nowMs);
    if (output) {
        lines.push(output);
    }
    return lines.join("\n");
}

// Row actions (#933): Interrupt reaches an agent working now in a local pane.
export function canInterrupt(s: DurableSession): boolean {
    return (
        !!s.agent &&
        s.agentstate === "working" &&
        s.shown &&
        !!s.blockid &&
        !s.connection &&
        s.reason !== "olderversion" &&
        s.reason !== "ending"
    );
}

// Up to date (#933): outdated is a terminal Update terminal knows (FR-SHELL-041) — its shell or its agent started with
// an older MoltenTerm environment; an older version is a session the installed MoltenTerm can only end.
export type VersionMark = "outdated" | "older" | null;

export function versionMark(s: DurableSession, outdatedBlocks: Set<string>): VersionMark {
    if (s.reason === "olderversion") {
        return "older";
    }
    if (s.blockid && outdatedBlocks.has(s.blockid) && !s.connection) {
        return "outdated";
    }
    return null;
}

export function canUpdate(s: DurableSession, outdatedBlocks: Set<string>): boolean {
    return versionMark(s, outdatedBlocks) === "outdated" && s.shown && s.reason !== "ending";
}

export function updateConfirmText(s: DurableSession, home: string): ConfirmText {
    const name = rowName(s, home);
    const agent = s.agent ? s.agentname || s.agent : "";
    let warning: string;
    if (s.agent && s.agentstate === "working") {
        warning = t("sessions.update.warningWorking", { agent });
    } else if (s.agent && s.agentstate === "waiting") {
        warning = t("sessions.update.warningWaiting", { agent });
    }
    return {
        title: t("sessions.update.title", { name }),
        subtitle: agent ? t("sessions.update.subtitleAgent", { agent }) : t("sessions.update.subtitleShell"),
        warning,
        confirm: t("sessions.update.confirm"),
    };
}

export function updateAllConfirmText(list: DurableSession[]): ConfirmText {
    const n = list.length;
    const sessions = plural(n, "sessions.count.sessions");
    return {
        title: t("sessions.updateAll.title", { sessions }),
        subtitle: t("sessions.updateAll.subtitle"),
        confirm: t("sessions.updateAll.confirm", { sessions }),
    };
}
