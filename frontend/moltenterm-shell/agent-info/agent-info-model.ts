// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What MoltenTerm knows about one agent (FR-SHELL-084, #1188), for the sidebar's agent tree and the "Everything about
// <agent>" window: its sub-agents (the companion's, read from Claude Code's or Codex's own files), the agents it is
// linked to by handoffs, its MoltenTerm MCP servers, the pages shared with it. Provider-agnostic: everything here comes
// from wavesrv's generic records; the per-agent reading happens in wavesrv's adapters. Only what is known is returned:
// an empty list hides its section.

import type { BlockLinks, HandoffHistoryEntry, LinkState } from "../agent-links/agent-links-model";
import type { AgentStateInfo } from "../agent-state-model";
import type { AgentTab } from "../browser/browser-agent";
import type { BrowserTab } from "../browser/browser-model";
import type { CompanionSubagent, CompanionView } from "../companion/companion-model";

export type LinkDirection = "in" | "out";

// One agent this one handed work to (out) or got work from (in), with the latest handoff's goal.
export type LinkedAgent = {
    blockId: string;
    dir: LinkDirection;
    name: string;
    goal: string;
    at: number;
    count: number;
};

// The handoffs in and out of blockId, one row per other agent and direction, the latest first. handedBy: the
// terminal that first handed each terminal work (its persisted block meta), which survives a restart while the
// history does not.
export function linkedAgents(
    blockId: string,
    history: HandoffHistoryEntry[],
    handedBy: Record<string, string>,
    nameOf: (blockId: string) => string
): LinkedAgent[] {
    if (!blockId) {
        return [];
    }
    const rows = new Map<string, LinkedAgent>();
    const add = (other: string, dir: LinkDirection, recorded: string, goal: string, at: number) => {
        if (!other || other === blockId) {
            return;
        }
        const key = `${dir}:${other}`;
        const row = rows.get(key);
        if (row == null) {
            rows.set(key, {
                blockId: other,
                dir,
                name: nameOf(other) || recorded || "",
                goal: goal ?? "",
                at,
                count: 1,
            });
            return;
        }
        row.count++;
        if (at >= row.at) {
            row.at = at;
            row.goal = goal || row.goal;
        }
        if (!row.name && recorded) {
            row.name = recorded;
        }
    };
    for (const e of history ?? []) {
        if (e.fromblockid === blockId) {
            add(e.toblockid, "out", e.to, e.goal, e.at);
        } else if (e.toblockid === blockId) {
            add(e.fromblockid, "in", e.from, e.goal, e.at);
        }
    }
    const parent = handedBy?.[blockId];
    if (parent && !rows.has(`in:${parent}`)) {
        add(parent, "in", "", "", 0);
    }
    for (const [child, from] of Object.entries(handedBy ?? {})) {
        if (from === blockId && !rows.has(`out:${child}`)) {
            add(child, "out", "", "", 0);
        }
    }
    return Array.from(rows.values()).sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
}

export type SubagentRowState = "working" | "idle" | "done" | "error";

export type SubagentRow = {
    id: string;
    name: string;
    kind: string;
    model: string;
    state: SubagentRowState;
    effort?: string;
    branch?: string;
    started?: number;
    ended?: number;
};

const SubagentStates: Record<string, SubagentRowState> = {
    running: "working",
    quiet: "idle",
    done: "done",
    stopped: "done",
    failed: "error",
};

// The sub-agents the companion lists for the agent's session, running ones first.
export function subagentRows(view: CompanionView): SubagentRow[] {
    const subs: CompanionSubagent[] = view?.subagents ?? [];
    const rank: Record<SubagentRowState, number> = { working: 0, idle: 1, error: 2, done: 3 };
    return subs
        .map((s) => ({
            id: s.id,
            name: (s.description || s.kind || "").trim(),
            kind: (s.kind ?? "").trim(),
            model: (s.model ?? "").trim(),
            state: SubagentStates[s.state] ?? "working",
            effort: (s.effort ?? "").trim(),
            branch: (s.branch ?? "").trim(),
            started: s.started ?? 0,
            ended: s.ended ?? 0,
        }))
        .filter((s) => s.name !== "")
        .sort((a, b) => rank[a.state] - rank[b.state]);
}

// The sidebar shows at most this many running sub-agents, then "+n" (FR-SHELL-104).
export const MaxRunningSubRows = 5;

export function subagentRunning(row: SubagentRow): boolean {
    return row?.state === "working" || row?.state === "idle";
}

// A finished sub-agent (done or stopped) cannot be called back, so the sidebar keeps it this long after it ended, for a
// glance at its mark, then drops it on its own (FR-SHELL-104, #1542). A failed one stays until it is seen.
export const SubagentLingerMs = 5 * 60 * 1000;

// Whether a sub-agent is a failure nobody has looked at yet: it stays listed until it is seen.
export function subagentFailureKey(row: SubagentRow): string {
    return `${row.started ?? 0}:${row.ended ?? 0}`;
}

export function subagentUnseenFailure(row: SubagentRow, seen: Record<string, string>): boolean {
    return row?.state === "error" && seen?.[row.id] !== subagentFailureKey(row);
}

// One with no recorded end cannot be timed, so it does not linger.
function subagentLingers(row: SubagentRow, now: number): boolean {
    return (row.ended ?? 0) > 0 && now - row.ended < SubagentLingerMs;
}

// The sub-agents of an agent as the sidebar groups them (FR-SHELL-104, #1542): the running ones (quiet included) and
// the finished ones still listed, which are the ones that ended less than SubagentLingerMs ago and the failures not
// yet seen. parentEnded: the agent no longer runs, so only the unseen failures remain.
export type SubagentGroups = {
    running: SubagentRow[];
    lingering: SubagentRow[];
    // working: how many are at work now (the header's one loader).
    working: number;
};

export function subagentGroups(
    rows: SubagentRow[],
    now: number,
    parentEnded: boolean,
    seen: Record<string, string>
): SubagentGroups {
    const running = (rows ?? []).filter(subagentRunning).sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
    const lingering = (rows ?? [])
        .filter((r) => !subagentRunning(r))
        .filter(
            (r) => subagentUnseenFailure(r, seen) || (!parentEnded && r.state !== "error" && subagentLingers(r, now))
        )
        .sort((a, b) => (b.ended ?? 0) - (a.ended ?? 0));
    return { running, lingering, working: running.filter((r) => r.state === "working").length };
}

// In how many ms the next finished sub-agent leaves the sidebar, null when none will: the caller waits that long, then
// reads the groups again. A failure not yet seen has no end to wait for.
export function nextSubagentExpiry(rows: SubagentRow[], now: number): number {
    let rtn: number = null;
    for (const r of rows ?? []) {
        if (subagentRunning(r) || r.state === "error" || !subagentLingers(r, now)) {
            continue;
        }
        const left = r.ended + SubagentLingerMs - now;
        rtn = rtn == null ? left : Math.min(rtn, left);
    }
    return rtn;
}

// The agent window's sub-agents (FR-SHELL-084, #1542): the running ones first, the failures not yet seen, then the
// finished ones, newest first, which the window folds into one line.
export type SubagentCardGroups = {
    running: SubagentRow[];
    unseen: SubagentRow[];
    finished: SubagentRow[];
    working: number;
};

export function subagentCardGroups(rows: SubagentRow[], seen: Record<string, string>): SubagentCardGroups {
    const running = (rows ?? []).filter(subagentRunning).sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
    const rest = (rows ?? []).filter((r) => !subagentRunning(r));
    const byEnd = (a: SubagentRow, b: SubagentRow) => (b.ended ?? 0) - (a.ended ?? 0);
    return {
        running,
        unseen: rest.filter((r) => subagentUnseenFailure(r, seen)).sort(byEnd),
        finished: rest.filter((r) => !subagentUnseenFailure(r, seen)).sort(byEnd),
        working: running.filter((r) => r.state === "working").length,
    };
}

export type SubagentDay = {
    // Days before today: 0 today, 1 yesterday; -1 when the end is unknown.
    daysAgo: number;
    // The day's start in ms (local time), 0 when unknown.
    day: number;
    rows: SubagentRow[];
};

function dayStart(ms: number): number {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// The finished sub-agents grouped by the local day they ended on, the latest day first; ones with no recorded end
// come last.
export function subagentDays(finished: SubagentRow[], now: number): SubagentDay[] {
    const today = dayStart(now);
    const days = new Map<number, SubagentDay>();
    for (const r of finished ?? []) {
        const day = r.ended > 0 ? dayStart(r.ended) : 0;
        let group = days.get(day);
        if (group == null) {
            group = { daysAgo: day > 0 ? Math.round((today - day) / 86_400_000) : -1, day, rows: [] };
            days.set(day, group);
        }
        group.rows.push(r);
    }
    return Array.from(days.values()).sort((a, b) => (a.day === 0 ? 1 : b.day === 0 ? -1 : b.day - a.day));
}

// "Today", "Yesterday", else the date, in the interface language.
export function subagentDayLabel(day: SubagentDay, locale: string): string {
    if (day.daysAgo < 0) {
        return "";
    }
    if (day.daysAgo > 1) {
        return new Date(day.day).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
    }
    const text = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-day.daysAgo, "day");
    return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
}

// The i18n key of a sub-agent type the agents name (Claude Code's subagent_type, Codex's agent_type); an unknown one
// (a user's own agent) shows as the agent names it.
const SubagentKindKeys: Record<string, string> = {
    "general-purpose": "general",
    default: "general",
    explore: "explore",
    explorer: "explore",
    plan: "plan",
    worker: "worker",
    "statusline-setup": "statusline",
    "claude-code-guide": "guide",
    "output-style-setup": "outputStyle",
};

export function subagentKindKey(kind: string): string {
    const key = SubagentKindKeys[(kind ?? "").trim().toLowerCase()];
    return key ? `agentInfo.subKind.${key}` : "";
}

// How long a sub-agent ran, or runs so far: "45 s", "4 min", "1 h 20 min", in the interface language.
export function subagentDuration(started: number, ended: number, now: number, locale: string): string {
    if (!started) {
        return "";
    }
    const end = ended || now;
    if (end < started) {
        return "";
    }
    const unit = (n: number, u: string) =>
        new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: "short" }).format(n);
    const seconds = Math.floor((end - started) / 1000);
    if (seconds < 60) {
        return unit(seconds, "second");
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return unit(minutes, "minute");
    }
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest > 0 ? `${unit(hours, "hour")} ${unit(rest, "minute")}` : unit(hours, "hour");
}

export type McpServerRow = { server: string; state: LinkState; live: boolean };

// The MoltenTerm MCP servers the agent's terminal is linked to, as the header's plug shows them (FR-CONT-022). The
// agent's other MCP servers are its own configuration, which the agent's adapter reads (agent-toolkit-model.ts, #1543).
export function mcpServerRows(links: BlockLinks): McpServerRow[] {
    const rtn: McpServerRow[] = [];
    const seen = new Set<string>();
    for (const agent of links?.agents ?? []) {
        for (const link of agent.links ?? []) {
            if (!link?.server || seen.has(link.server)) {
                continue;
            }
            seen.add(link.server);
            rtn.push({ server: link.server, state: link.state, live: link.state === "connected" });
        }
    }
    return rtn.sort((a, b) => a.server.localeCompare(b.server));
}

export type SharedPage = {
    panelBlockId: string;
    tabId: string;
    browserTabId: string;
    title: string;
    url: string;
    shared: boolean;
};

// The browser tabs an agent holds in one panel: the ones the user shared with it, and the ones it opened.
export function sharedPages(
    panelBlockId: string,
    tabId: string,
    agentBlockId: string,
    agentTabs: AgentTab[],
    browserTabs: BrowserTab[]
): SharedPage[] {
    const rtn: SharedPage[] = [];
    for (const held of agentTabs ?? []) {
        if (held?.agentblockid !== agentBlockId) {
            continue;
        }
        const tab = (browserTabs ?? []).find((b) => b.id === held.browsertabid);
        if (tab == null) {
            continue;
        }
        rtn.push({
            panelBlockId,
            tabId,
            browserTabId: tab.id,
            title: (tab.title ?? "").trim() || tab.url,
            url: tab.url,
            shared: held.origin === "shared",
        });
    }
    return rtn;
}

// The agent's tool as it names itself ("Claude Code"), else its id.
export function agentTool(info: AgentStateInfo): string {
    return (info?.agentname || info?.agent || "").trim();
}

// "2 h 10 min ago", or for less than a minute, "just now" (the caller's words); in the interface language.
export function startedAgo(started: number, now: number, locale: string): string {
    if (!started || started > now) {
        return "";
    }
    const minutes = Math.floor((now - started) / 60_000);
    const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    if (minutes < 60) {
        return format.format(-minutes, "minute");
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 48) {
        return format.format(-hours, "hour");
    }
    return format.format(-Math.floor(hours / 24), "day");
}
