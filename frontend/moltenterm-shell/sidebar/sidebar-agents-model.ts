// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The sidebar's agents (FR-SHELL-084, DS of #1181): one row per agent of the workspace, from wavesrv's agent states,
// those at work first; a temporary view owned by an agent is listed under that agent, not twice.

import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";

const RowOrder: Record<string, number> = { working: 0, waiting: 1, error: 2, idle: 3, done: 4 };

// The agents of a workspace: the terminals where MoltenTerm detected an agent, working, waiting, in error, at their
// prompt, then finished; the longest running first within a state.
export function workspaceAgents(data: AgentStatesData, workspaceId: string): AgentStateInfo[] {
    if (!workspaceId) {
        return [];
    }
    return Object.values(data?.states ?? {})
        .filter((s) => s.workspaceid === workspaceId && !!(s.agent || s.agentname))
        .sort(
            (a, b) =>
                (RowOrder[a.state] ?? 3) - (RowOrder[b.state] ?? 3) ||
                (a.started ?? Infinity) - (b.started ?? Infinity) ||
                (a.firstname ?? "").localeCompare(b.firstname ?? "") ||
                a.blockid.localeCompare(b.blockid)
        );
}

// The row's look: working shows the dominoes, waiting and error a dot and coloured text, done a green dot on a dimmed
// row, idle nothing.
export type AgentRowLook = "working" | "waiting" | "error" | "done" | "idle";

export function agentRowLook(info: AgentStateInfo): AgentRowLook {
    switch (info?.state) {
        case "working":
        case "waiting":
        case "error":
        case "done":
            return info.state;
    }
    return "idle";
}

// The temporary views an agent owns: a view holding one agent's terminal and no other agent's. A view holding two
// agents stays in the temporary views, so nothing is hidden under the wrong one.
export function agentOwnedViews(temporaryTabIds: string[], agents: AgentStateInfo[]): Map<string, string> {
    const temporary = new Set(temporaryTabIds ?? []);
    const byTab = new Map<string, string[]>();
    for (const a of agents ?? []) {
        if (!a.tabid || !temporary.has(a.tabid)) {
            continue;
        }
        byTab.set(a.tabid, [...(byTab.get(a.tabid) ?? []), a.blockid]);
    }
    const rtn = new Map<string, string>();
    for (const [tabId, blocks] of byTab) {
        if (blocks.length === 1) {
            rtn.set(tabId, blocks[0]);
        }
    }
    return rtn;
}

// What the developer opened or closed in an agent's tree, kept per agent terminal: the tree itself, and each section.
export type AgentTreeSection = "subs" | "links";
export type AgentTreeState = { open?: boolean; shut?: Partial<Record<AgentTreeSection, boolean>> };
export type AgentTreeStates = Record<string, AgentTreeState>;

export const MaxKeptTrees = 100;

export function toggleTree(states: AgentTreeStates, blockId: string): AgentTreeStates {
    const cur = states?.[blockId] ?? {};
    return keepRecent({ ...states, [blockId]: { ...cur, open: !cur.open } }, blockId);
}

export function toggleSection(states: AgentTreeStates, blockId: string, section: AgentTreeSection): AgentTreeStates {
    const cur = states?.[blockId] ?? {};
    const shut = { ...(cur.shut ?? {}), [section]: !cur.shut?.[section] };
    return keepRecent({ ...states, [blockId]: { ...cur, shut } }, blockId);
}

// Agent terminals come and go: only the latest MaxKeptTrees states are kept, the one just changed last.
function keepRecent(states: AgentTreeStates, changed: string): AgentTreeStates {
    const { [changed]: own, ...rest } = states;
    const keys = Object.keys(rest);
    const kept = keys.slice(Math.max(0, keys.length - (MaxKeptTrees - 1)));
    const rtn: AgentTreeStates = {};
    for (const k of kept) {
        rtn[k] = rest[k];
    }
    rtn[changed] = own;
    return rtn;
}

export function readTreeStates(raw: unknown): AgentTreeStates {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        return {};
    }
    const rtn: AgentTreeStates = {};
    for (const [k, v] of Object.entries(raw as Record<string, any>)) {
        if (v == null || typeof v !== "object") {
            continue;
        }
        const shut: AgentTreeState["shut"] = {};
        if (v.shut?.subs === true) {
            shut.subs = true;
        }
        if (v.shut?.links === true) {
            shut.links = true;
        }
        rtn[k] = { open: v.open === true, shut };
    }
    return rtn;
}
