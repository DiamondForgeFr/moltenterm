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
// A line pasted into an agent stays English, its placeholder included (#749): agents read English, and a line mixing
// two languages reads as broken. The text around it, shown to the user, is translated and says what to replace.
export const GenericRequestPlaceholder = "<what you want MoltenTerm to do>";

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
    // the catalog's official install commands (pkg/molten/onboarding/agents.go), the first the one Install runs
    installcommands?: string[];
    // the vendor's page to sign in or create an account (#1680)
    signinpage?: string;
    // wavesrv saw the agent's documented credentials file; false when it cannot tell, never a proof of the contrary
    signedin?: boolean;
    // the vendor's product page and docs (#1699)
    site?: string;
    docs?: string;
    // the vendor's uninstall for the way the copy found was installed; available only when it is documented
    uninstall?: AgentUninstall;
    // every way the catalog knows, documented or not, for the manual instructions
    uninstallmethods?: AgentUninstall[];
    // the plain-words profile (#1697), any field may be missing
    profile?: AgentFacts;
};

// must match pkg/molten/onboarding/agentpage.go
export type AgentUninstall = {
    method: string;
    // the vendor's command, verbatim; empty when the vendor documents none for this method
    command?: string;
    // false: the reverse of the install, which the vendor does not document; shown by hand, never run
    documented?: boolean;
    removes?: string[];
    source?: string;
    // the user's own settings and sign-in folders the vendor says to delete for a full removal; never removed unticked
    config?: string[];
    configsource?: string;
    // the i18n key saying in plain words what those folders hold
    configholdskey?: string;
    available?: boolean;
};

export type FactAnswer = "yes" | "no" | "notstated";

// the cheapest plan that unlocks the CLI, as the vendor's page shows it; no amount when the vendor does not state it
export type AgentPrice = { amount?: string; currency?: string; period?: string; plan?: string; notekey?: string };

// must match pkg/molten/onboarding/agentfacts.go (FR-ONB-008 AC-4): sentences are i18n keys, the rest is data
export type AgentFacts = {
    checkedon?: string;
    pricingpage?: string;
    modelspage?: string;
    freetier?: FactAnswer;
    from?: AgentPrice;
    models?: string[];
    goodforkey?: string;
    strengthkeys?: string[];
    weakkeys?: string[];
    speedkey?: string;
    limitskey?: string;
    notekey?: string;
    notepage?: string;
    beyondcode?: Record<string, FactAnswer>;
    uses?: string[];
    includedin?: string[];
    sources?: string[];
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
