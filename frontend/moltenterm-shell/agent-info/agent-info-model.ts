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

// The sub-agents of an agent as the sidebar groups them (FR-SHELL-104, #1333): the running ones (quiet included), the
// finished ones that ended during the parent's current turn, still shown as rows, and the older ones, folded under
// "Done (n)". A finished one is gone once cleared by hand, and all are once the parent no longer runs.
export type SubagentGroups = {
    running: SubagentRow[];
    recent: SubagentRow[];
    folded: SubagentRow[];
    // working: how many are at work now (the header's one loader).
    working: number;
};

export function subagentGroups(
    rows: SubagentRow[],
    turnStart: number,
    parentEnded: boolean,
    cleared: Record<string, boolean>
): SubagentGroups {
    const running = (rows ?? []).filter(subagentRunning).sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
    const done = parentEnded
        ? []
        : (rows ?? [])
              .filter((r) => !subagentRunning(r) && !cleared?.[r.id])
              .sort((a, b) => (b.ended ?? 0) - (a.ended ?? 0));
    const isRecent = (r: SubagentRow) => turnStart > 0 && (!r.ended || r.ended >= turnStart);
    return {
        running,
        recent: done.filter(isRecent),
        folded: done.filter((r) => !isRecent(r)),
        working: running.filter((r) => r.state === "working").length,
    };
}

// The parent's current turn: when its latest prompt was typed, 0 when unknown (then every finished one is folded).
// A topic only lists once its turn used a tool: the session's last prompt comes first.
export function parentTurnStart(view: CompanionView): number {
    let rtn = view?.session?.lastprompt ?? 0;
    for (const t of view?.topics ?? []) {
        rtn = Math.max(rtn, t.at ?? 0);
    }
    return rtn;
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
// agent's other MCP servers are its own configuration, which MoltenTerm does not read.
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
