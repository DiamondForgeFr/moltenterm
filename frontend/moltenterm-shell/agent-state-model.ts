// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Agent states (FR-SHELL-011, DS-SHELL-011): wavesrv keeps the coding agent of each terminal and its state
// (pkg/molten/attention/agentstate.go); the windows show them in the pane header, on the tab and on the workspace
// icon of the rail. Kept apart from the components so the rules can be tested without the app.

// must match pkg/molten/agentstate.go
export const AgentStateEvent = "molten:agentstate";
export const AgentStatesRoute = "molten:agents";
export const AgentStatesCommand = "moltenagentstates";

export type AgentStateName = "working" | "waiting" | "done" | "error" | "idle";

// must match AgentStateInfo in pkg/molten/agentstate.go
export type AgentStateInfo = {
    blockid: string;
    tabid?: string;
    workspaceid?: string;
    agent?: string;
    agentname?: string;
    state?: AgentStateName;
    message?: string;
    since?: number;
    version: number;
    cleared?: boolean;
};

export type AgentStatesData = {
    states: Record<string, AgentStateInfo>;
    // The last version seen per block, cleared ones included: an older event must not bring a closed agent back.
    versions: Record<string, number>;
};

export const EmptyAgentStates: AgentStatesData = { states: {}, versions: {} };

const Urgency: Record<string, number> = { waiting: 4, error: 3, working: 2, done: 1, idle: 0 };

export function agentStateUrgency(state: string): number {
    return Urgency[state] ?? 0;
}

// Applies events or a snapshot; returns the same object when nothing changes, so atoms do not re-render.
export function applyAgentStates(data: AgentStatesData, infos: AgentStateInfo[]): AgentStatesData {
    let next: AgentStatesData = null;
    for (const info of infos ?? []) {
        if (!info?.blockid) {
            continue;
        }
        const current = (next ?? data).versions[info.blockid] ?? 0;
        if (info.version <= current) {
            continue;
        }
        if (next == null) {
            next = { states: { ...data.states }, versions: { ...data.versions } };
        }
        next.versions[info.blockid] = info.version;
        if (info.cleared) {
            delete next.states[info.blockid];
        } else {
            next.states[info.blockid] = info;
        }
    }
    return next ?? data;
}

// The state a tab or a workspace shows: the most urgent of its panes' (waiting, error, working, done); idle shows
// nothing.
export function mostUrgentAgentState(infos: AgentStateInfo[]): AgentStateInfo {
    let best: AgentStateInfo = null;
    for (const info of infos) {
        if (info == null || agentStateUrgency(info.state) === 0) {
            continue;
        }
        if (best == null || agentStateUrgency(info.state) > agentStateUrgency(best.state)) {
            best = info;
        }
    }
    return best;
}

export function agentStatesOfBlocks(data: AgentStatesData, blockIds: string[]): AgentStateInfo[] {
    return (blockIds ?? []).map((id) => data.states[id]).filter((s) => s != null);
}

export function agentStatesOfWorkspace(data: AgentStatesData, workspaceId: string): AgentStateInfo[] {
    return Object.values(data.states).filter((s) => s.workspaceid === workspaceId);
}

const StateLabels: Record<string, string> = {
    working: "working",
    waiting: "waiting for you",
    done: "done",
    error: "error",
    idle: "idle",
};

export function agentStateLabel(state: string): string {
    return StateLabels[state] ?? state ?? "";
}

// The dot's colour per state, as class strings (the theme's tokens).
export const AgentStateDotClasses: Record<string, string> = {
    waiting: "bg-warning",
    error: "bg-error",
    working: "bg-accent",
    done: "bg-success",
    idle: "bg-secondary",
};

export function agentStateTitle(info: AgentStateInfo): string {
    if (info == null) {
        return "";
    }
    const name = info.agentname || info.agent || "Agent";
    const line = `${name}: ${agentStateLabel(info.state)}`;
    return info.message ? `${line}\n${info.message}` : line;
}

// What the header says next to the agent: project and branch, when the pane's folder is known.
export function agentHeaderParts(info: AgentStateInfo, projectName: string, branch: string): string[] {
    if (info == null) {
        return [];
    }
    return [info.agentname || info.agent || "Agent", projectName, branch].filter((s) => !!s);
}
