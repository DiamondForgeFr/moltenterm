// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// No silent failure for an agent-dependent action (FR-AGC-005): before MoltenTerm offers an action that needs the
// agent's MCP, hooks, guides or runner, it reads the agent's cell of the compatibility matrix (FR-AGC-001). A cell at
// none makes the action say why where it is offered, with another way (another agent, the agent's own command, a
// molten command); the other levels let it run, and its own refusals speak. The one place the surfaces ask, so a new
// agent's row is read everywhere at once.

import { t } from "../i18n/i18n";
import {
    agentFeature,
    agentRow,
    currentFeatureMatrix,
    useFeatureMatrix,
    type FeatureLevel,
    type FeatureMatrix,
} from "./agent-features-model";

export type AgentAction = "morph" | "commands" | "effort" | "resume" | "send" | "review" | "usage";

// The matrix feature each action stands on (pkg/molten/agentcontinuity/features.go).
export const ActionFeatures: Record<AgentAction, string> = {
    morph: "guides",
    commands: "commands",
    effort: "effort",
    resume: "resume",
    send: "browsermcp",
    review: "runner",
    usage: "usage",
};

// unknown: no matrix or no agent: the action is offered as before and its own errors speak, since a soft signal never
// blocks what the system allows (#943).
export type ActionGate = {
    action: AgentAction;
    agent: string;
    // The agent's product name from the matrix, "" when it has no row.
    agentName: string;
    level: FeatureLevel | "unknown";
    // native, adapted and process-only work (process-only in the narrower way its matrix note says); none does not.
    works: boolean;
};

export function actionGate(matrix: FeatureMatrix, agent: string, action: AgentAction): ActionGate {
    const base = { action, agent: agent ?? "", agentName: agentRow(matrix, agent)?.name ?? "" };
    if (matrix?.agents == null || !agent) {
        return { ...base, level: "unknown", works: true };
    }
    const level = agentFeature(matrix, agent, ActionFeatures[action]).level;
    return { ...base, level, works: level !== "none" };
}

function displayName(gate: ActionGate, name?: string): string {
    return name || gate.agentName || gate.agent || t("agc.gate.thisAgent");
}

// Why the action does not work with this agent, in plain words; "" when it works.
export function gateReason(gate: ActionGate, name?: string): string {
    if (gate.works) {
        return "";
    }
    return t(`agc.gate.${gate.action}.none`, { agent: displayName(gate, name) });
}

// What works instead: another agent, the agent's own way, a molten command.
export function gateAlternative(gate: ActionGate, name?: string): string {
    return t(`agc.gate.${gate.action}.alt`, { agent: displayName(gate, name) });
}

// The reason and the way out, as one sentence pair for a tooltip or a panel message.
export function gateMessage(gate: ActionGate, name?: string): string {
    if (gate.works) {
        return "";
    }
    return `${gateReason(gate, name)} ${gateAlternative(gate, name)}`;
}

// Whether the /morph request may go to the agent: an agent the matrix does not know gets it as plain text (#1680), so
// only a row whose guides are none keeps it from being typed there.
export function morphWorks(matrix: FeatureMatrix, agent: string): boolean {
    return agentRow(matrix, agent) == null || actionGate(matrix, agent, "morph").works;
}

// The gate from the matrix the window has now (models, menus, command panel providers).
export function currentActionGate(agent: string, action: AgentAction): ActionGate {
    return actionGate(currentFeatureMatrix(), agent, action);
}

export function useActionGate(agent: string, action: AgentAction): ActionGate {
    return actionGate(useFeatureMatrix(), agent, action);
}
