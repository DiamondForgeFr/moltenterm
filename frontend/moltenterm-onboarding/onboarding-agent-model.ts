// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What step 1, "Your agent" (FR-ONB-002, DS-ONB-002), shows, from wavesrv's listing (pkg/molten/onboarding/agents.go).
// Pure, so the rules are tested without a window. Step 2 (#163) reads the agent chosen here from the step's data.

// must match pkg/molten/onboarding/agents.go
export const OnboardingAgentsCommand = "onboardingagents";
export const OnboardingAgentInstallCommand = "onboardingagentinstall";

export const GenericAgentId = "generic";
// The step's data key holding the id of the agent the user works with.
export const ChosenAgentKey = "agent";

export type OnboardingGuide = {
    name: string;
    path: string;
    invocation: string;
    installed: boolean;
    version?: string;
    foreign?: boolean;
};

export type OnboardingAgent = {
    id: string;
    name: string;
    path: string;
    invocation: string;
    format: string;
    installed: boolean;
    version?: string;
    foreign?: boolean;
    guides: OnboardingGuide[];
    declined?: boolean;
    executable?: string;
    found: boolean;
    foundpath?: string;
    installpage?: string;
};

export type OnboardingAgents = { agents: OnboardingAgent[]; version: string };

export type AgentGuideState = "installed" | "outdated" | "foreign" | "missing";

// The call without its "<request>" part: "/morph", "$morph", "/skill:morph".
export function guideCall(invocation: string): string {
    return (invocation ?? "").replace(/\s*<request>\s*$/, "").trim();
}

// The call with a request, in the agent's own syntax.
export function guideRequest(invocation: string, request: string): string {
    return (invocation ?? "").replace("<request>", request);
}

export function guideState(guide: OnboardingGuide, version: string): AgentGuideState {
    if (guide.foreign) {
        return "foreign";
    }
    if (!guide.installed) {
        return "missing";
    }
    return version && guide.version !== version ? "outdated" : "installed";
}

// The catalog's agents (generic aside), found ones first, each group in the catalog's order.
export function catalogAgents(list: OnboardingAgents): OnboardingAgent[] {
    const agents = (list?.agents ?? []).filter((a) => a.id !== GenericAgentId);
    return [...agents.filter((a) => a.found), ...agents.filter((a) => !a.found)];
}

export function genericAgent(list: OnboardingAgents): OnboardingAgent {
    return (list?.agents ?? []).find((a) => a.id === GenericAgentId) ?? null;
}

export function foundAgents(list: OnboardingAgents): OnboardingAgent[] {
    return catalogAgents(list).filter((a) => a.found);
}

// The agent the step offers to keep: the one saved, while it is still found, else the only one found.
export function preselectedAgent(list: OnboardingAgents, saved: string): string {
    const found = foundAgents(list);
    if (saved && found.some((a) => a.id === saved)) {
        return saved;
    }
    return found.length === 1 ? found[0].id : null;
}

// Whether `/morph` works in the agent now: its morph guide is written by molten and the agent was not declined.
export function canMorph(agent: OnboardingAgent): boolean {
    return agent != null && !agent.declined && agent.installed && !agent.foreign;
}

// The sentence to give any other coding agent: the generic profile's invocation with its instruction file.
export function genericRequest(agent: OnboardingAgent, request: string): string {
    if (agent == null) {
        return "";
    }
    return guideRequest(agent.invocation, request);
}
