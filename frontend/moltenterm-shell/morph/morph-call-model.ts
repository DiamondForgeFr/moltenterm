// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Asking the workspace's agent for a missing tool with /morph (#1653, #1672): the Library's "Missing a tool?" card
// and the ⌘T launcher's empty result share these rules. Pure functions, tested without the app.

import { agentRow, currentFeatureMatrix, guideCall, type FeatureMatrix } from "../agent-info/agent-features-model";
import { agentPromptState, type AgentStateInfo, type AgentStatesData } from "../agent-state-model";
import { workspaceAgents } from "../library/library-model";

// Each agent's own call of the morph guide (pkg/molten/agentdocs/mod-format.md), from its row of the compatibility
// matrix (FR-AGC-003). An agent the matrix does not know has no call (#1680): the request goes to it as plain text.
// The agent named nowhere yet (no state id) is taken as one with the guides.
export function morphCall(agent: string, matrix: FeatureMatrix = currentFeatureMatrix()): string {
    if (!agent) {
        return "/morph";
    }
    if (agentRow(matrix, agent) == null) {
        return "";
    }
    return guideCall(matrix, agent, "morph");
}

// What is typed into the agent's terminal: the call, a space and the request, never Enter, so the developer completes
// the request and sends it. A line break or a control character of the request would send it: they become spaces.
export function morphCallText(agent: string, request?: string): string {
    // eslint-disable-next-line no-control-regex
    const clean = (request ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    const call = morphCall(agent);
    return call ? `${call} ${clean}` : clean;
}

// The workspace's agent the call goes to, or null when the workspace has none.
export function workspaceMorphTarget(data: AgentStatesData, workspaceId: string, tabId: string): AgentStateInfo {
    return morphTarget(workspaceAgents(data, workspaceId), tabId);
}

// Where the call goes when the agents' guides differ (FR-AGC-005): agent, the best of those that run MoltenTerm's
// guides; unable, the one it would have gone to when none of them can, so the card says why instead of typing a call
// the agent does not know. canMorph reads the compatibility matrix (agent-action-gate.ts).
export type MorphChoice = { agent: AgentStateInfo; unable: AgentStateInfo };

export function morphChoice(
    agents: AgentStateInfo[],
    tabId: string,
    canMorph: (agent: string) => boolean
): MorphChoice {
    const agent = morphTarget(
        (agents ?? []).filter((a) => canMorph(a.agent)),
        tabId
    );
    return { agent, unable: agent == null ? morphTarget(agents, tabId) : null };
}

export function workspaceMorphChoice(
    data: AgentStatesData,
    workspaceId: string,
    tabId: string,
    canMorph: (agent: string) => boolean
): MorphChoice {
    return morphChoice(workspaceAgents(data, workspaceId), tabId, canMorph);
}

// The agent the call is typed into: the current view's first, then one whose prompt is free, then the latest.
export function morphTarget(agents: AgentStateInfo[], tabId: string): AgentStateInfo {
    const free = (a: AgentStateInfo) => (agentPromptState(a) === "working" ? 0 : 1);
    const here = (a: AgentStateInfo) => (tabId && a.tabid === tabId ? 1 : 0);
    const sorted = [...(agents ?? [])].sort(
        (a, b) =>
            here(b) - here(a) ||
            free(b) - free(a) ||
            (b.started ?? 0) - (a.started ?? 0) ||
            a.blockid.localeCompare(b.blockid)
    );
    return sorted[0] ?? null;
}
