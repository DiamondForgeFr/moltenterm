// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Scene 2 of the pour, "Your agents heat up" (FR-ONB-007 AC-4, AC-5): one card per catalog agent from wavesrv's real
// detection (FR-ONB-002, pkg/molten/onboarding/agents.go), and a DeepSeek card, a recipe for Claude Code. Install
// shows the official command to copy: nothing runs from the pour (installing in a terminal beside it is 1.1.0). The
// provider names are data here and reach the sentences as placeholders (provider-neutral words, #1452).

import { canMorph, catalogAgents, OnboardingAgent, OnboardingAgents } from "./onboarding-agent-model";

export const DeepSeekCardId = "deepseek";
export const ClaudeCodeId = "claude-code";
export const CodexId = "codex";

// The agents MoltenTerm hooks up fully when they start in its terminals (precise states, usage, the browser); the
// others are recognised by their process.
export const FullIntegrationIds = [ClaudeCodeId, CodexId];

// Keys of onboarding.pour.agents.account.<kind>, each with a {provider} placeholder.
export type AccountKind = "subscriptionOrKey" | "accountOrKey" | "subscription" | "apiKey";

type AgentFacts = {
    account: AccountKind;
    provider: string;
    // The official install commands, verified on 2026-10-31; the first is the one proposed.
    install: string[];
};

const Facts: Record<string, AgentFacts> = {
    [ClaudeCodeId]: {
        account: "subscriptionOrKey",
        provider: "Claude",
        install: ["curl -fsSL https://claude.ai/install.sh | bash"],
    },
    [CodexId]: {
        account: "subscriptionOrKey",
        provider: "ChatGPT",
        install: ["npm i -g @openai/codex", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"],
    },
    "gemini-cli": { account: "accountOrKey", provider: "Google", install: ["npm install -g @google/gemini-cli"] },
    "qwen-code": { account: "accountOrKey", provider: "Qwen", install: ["npm i -g @qwen-code/qwen-code"] },
    kimi: {
        account: "subscription",
        provider: "Kimi",
        install: ["curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"],
    },
};

export const DeepSeekName = "DeepSeek";
export const DeepSeekGuideUrl = "https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code";
export const DeepSeekKeyPlaceholder = "<your DeepSeek API key>";
// The two variables that send Claude Code to DeepSeek's Anthropic-compatible endpoint; the model variables are on
// DeepSeek's page, linked, since its model names change.
export const DeepSeekRecipe = [
    "export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic",
    `export ANTHROPIC_AUTH_TOKEN=${DeepSeekKeyPlaceholder}`,
    "claude",
];
// Codex asks once, in its /hooks command, before it runs the hooks MoltenTerm installs.
export const CodexHooksCommand = "/hooks";

export type PourAgentCard = {
    id: string;
    name: string;
    // the command that starts it, shown after "$ "
    command: string;
    ready: boolean;
    full: boolean;
    account: AccountKind;
    provider: string;
    install: string[];
    installPage?: string;
    // the agent a recipe runs in (DeepSeek: Claude Code)
    agentName?: string;
    // the DeepSeek card: Configure shows a recipe rather than an install command
    recipe?: boolean;
    // Codex: approve MoltenTerm's hooks in /hooks once
    hooksNote?: boolean;
};

function agentCard(agent: OnboardingAgent): PourAgentCard {
    const facts = Facts[agent.id];
    return {
        id: agent.id,
        name: agent.name,
        command: agent.executable || agent.id,
        ready: agent.found,
        full: FullIntegrationIds.includes(agent.id),
        account: facts?.account ?? "apiKey",
        provider: facts?.provider ?? agent.name,
        install: facts?.install ?? [],
        installPage: agent.installpage,
        hooksNote: agent.id === CodexId,
    };
}

export function deepSeekCard(list: OnboardingAgents): PourAgentCard {
    const claude = (list?.agents ?? []).find((a) => a.id === ClaudeCodeId);
    return {
        id: DeepSeekCardId,
        name: DeepSeekName,
        command: claude?.executable || "claude",
        agentName: claude?.name || "Claude Code",
        ready: false,
        full: false,
        account: "apiKey",
        provider: DeepSeekName,
        install: [],
        installPage: DeepSeekGuideUrl,
        recipe: true,
    };
}

// The catalog's agents, found ones first (catalogAgents), then DeepSeek.
export function pourAgentCards(list: OnboardingAgents): PourAgentCard[] {
    if (list == null) {
        return [];
    }
    return [...catalogAgents(list).map(agentCard), deepSeekCard(list)];
}

export function readyCount(cards: PourAgentCard[]): number {
    return (cards ?? []).filter((c) => c.ready).length;
}

// The sentence above the cards: how many agents MoltenTerm found (keys onboarding.pour.agents.found.<n>).
export function foundSentenceKey(count: number): string {
    if (count <= 0) {
        return "onboarding.pour.agents.found.none";
    }
    return count === 1 ? "onboarding.pour.agents.found.one" : "onboarding.pour.agents.found.other";
}

// The agents that became ready since the last detection, for "{name} is ready".
export function newlyReady(before: PourAgentCard[], after: PourAgentCard[]): PourAgentCard[] {
    const was = new Set((before ?? []).filter((c) => c.ready).map((c) => c.id));
    return (after ?? []).filter((c) => c.ready && !was.has(c.id));
}

// The agent the pour keeps for /morph (the agent step's data, FR-ONB-003): the first found whose /morph guide works,
// else the first found; null when none is.
export function keptAgent(list: OnboardingAgents): OnboardingAgent {
    const found = catalogAgents(list).filter((a) => a.found);
    return found.find((a) => canMorph(a) && a.executable) ?? found[0] ?? null;
}

// The two names the first scene's sentence starts with ("Claude Code, Codex and the others"), from the catalog.
export function headlineAgentNames(list: OnboardingAgents): [string, string] {
    const byId = (id: string, fallback: string) => (list?.agents ?? []).find((a) => a.id === id)?.name || fallback;
    return [byId(ClaudeCodeId, "Claude Code"), byId(CodexId, "Codex")];
}
