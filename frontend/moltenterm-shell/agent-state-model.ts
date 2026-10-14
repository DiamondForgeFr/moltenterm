// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Agent states (FR-SHELL-011, DS-SHELL-011): wavesrv keeps the coding agent of each terminal and its state
// (pkg/molten/attention/agentstate.go); the windows show them in the pane header, on the tab and on the workspace
// icon of the rail. Kept apart from the components so the rules can be tested without the app.

import { t } from "./i18n/i18n";

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
    // The session's first name, unique among the app's active agents (FR-CONT-014).
    firstname?: string;
    state?: AgentStateName;
    message?: string;
    since?: number;
    version: number;
    hooked?: boolean;
    // The run's model and effort level as the agent last reported them (#549), absent when unknown.
    model?: string;
    modelname?: string;
    effort?: string;
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

const StateNames = ["working", "waiting", "done", "error", "idle"];

export function agentStateLabel(state: string): string {
    if (StateNames.includes(state)) return t(`agent.state.${state}`);
    return state ?? "";
}

// The dot's colour per state, as class strings (the theme's tokens). Working is a ring, like the tab's mark, so it
// stays apart from waiting's filled amber dot when it stands still (#473: the dot no longer pulses on its own).
export const AgentStateDotClasses: Record<string, string> = {
    waiting: "bg-warning",
    error: "bg-error",
    working: "border-2 border-[var(--mt-state-working)]",
    done: "bg-success",
    idle: "bg-secondary",
};

// How a list or a title names a session's agent (FR-CONT-014): "[Jérôme] Claude Code", the agent's name alone without
// a first name. Must match AgentLabel in pkg/molten/agentstate.go.
export function agentLabel(info: AgentStateInfo, fallback = "Agent"): string {
    const kind = info?.agentname || info?.agent || fallback;
    const first = (info?.firstname ?? "").trim();
    return first ? `[${first}] ${kind}` : kind;
}

// How a sentence names a session's agent: its first name, else the agent's name ("Shared with Jérôme").
export function agentCallName(info: AgentStateInfo, fallback = "Agent"): string {
    return (info?.firstname ?? "").trim() || info?.agentname || info?.agent || fallback;
}

export function agentStateTitle(info: AgentStateInfo): string {
    if (info == null) {
        return "";
    }
    const name = agentLabel(info);
    const line = t("agent.stateLine", { name, state: agentStateLabel(info.state) });
    return info.message ? `${line}\n${info.message}` : line;
}

// The model and effort the header and the companion show beside the agent ("Opus · high", #549): only what the agent
// reported, so an unknown effort shows the model alone and an unknown model nothing.
export function agentModelEffortLabel(info: AgentStateInfo): string {
    const model = (info?.modelname || info?.model || "").trim();
    if (!model) {
        return "";
    }
    const effort = (info?.effort ?? "").trim();
    return effort ? `${model} · ${effort}` : model;
}

// The header's two click targets (#573): the model, which opens the Model choice, and the effort, which opens Effort;
// "" for a part the agent did not report.
export function agentModelPart(info: AgentStateInfo): string {
    return (info?.modelname || info?.model || "").trim();
}

export function agentEffortPart(info: AgentStateInfo): string {
    if (!agentModelPart(info)) {
        return "";
    }
    return (info?.effort ?? "").trim();
}

export function agentModelTitle(info: AgentStateInfo): string {
    const label = agentModelPart(info);
    if (!label) {
        return "";
    }
    const model =
        info.model && info.modelname && info.model !== info.modelname ? `${info.modelname} (${info.model})` : label;
    return [t("agent.modelTitle", { model }), t("agent.modelClick")].join("\n");
}

export function agentEffortTitle(info: AgentStateInfo): string {
    const effort = agentEffortPart(info);
    if (!effort) {
        return "";
    }
    return [t("agent.effortTitle", { effort }), t("agent.effortClick")].join("\n");
}

// What the header says next to the agent: project and branch, when the pane's folder is known.
export function agentHeaderParts(info: AgentStateInfo, projectName: string, branch: string): string[] {
    if (info == null) {
        return [];
    }
    return [agentLabel(info), projectName, branch].filter((s) => !!s);
}
