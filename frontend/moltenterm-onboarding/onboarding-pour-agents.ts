// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Scene 2 of the pour, "Your agents heat up" (FR-ONB-007 AC-4, AC-5): one card per catalog agent from wavesrv's real
// detection (FR-ONB-002, pkg/molten/onboarding/agents.go), and recipe cards for subscriptions that run in Claude Code
// (GLM Coding Plan, MiniMax). Install runs the official command of wavesrv's catalog (agents.go, #1667), which the
// card shows and keeps to copy; then the card says which account the agent needs and opens the vendor's sign-in page
// (#1680). MoltenTerm offers every agent as a browser offers every search engine: the cards are equal, in the same
// layout, the ones found on this computer first and the others in alphabetical order, never ranked by vendor. The
// provider names are data here and reach the sentences as placeholders (provider-neutral words, #1452).

import { canMorph, catalogAgents, OnboardingAgent, OnboardingAgents } from "./onboarding-agent-model";

export const GlmCardId = "glm";
export const MiniMaxCardId = "minimax";
export const ClaudeCodeId = "claude-code";
export const CodexId = "codex";
export const GeminiCliId = "gemini-cli";

// The agents MoltenTerm hooks up fully when they start in its terminals (precise states, usage, the browser); the
// others are recognised by their process.
export const FullIntegrationIds = [ClaudeCodeId, CodexId];

// Keys of onboarding.pour.agents.account.<kind>, each with a {provider} placeholder.
export type AccountKind =
    | "subscriptionOrKey"
    | "accountOrKey"
    | "subscription"
    | "apiKey"
    | "accountFree"
    | "planKey"
    | "enterpriseOrKey";

type AgentFacts = {
    account: AccountKind;
    provider: string;
};

// Which account each agent signs in with, from the vendors' docs (checked on 2026-11-01 for #1680).
const Facts: Record<string, AgentFacts> = {
    [ClaudeCodeId]: { account: "subscriptionOrKey", provider: "Claude" },
    [CodexId]: { account: "subscriptionOrKey", provider: "ChatGPT" },
    // Antigravity CLI took over personal Google accounts on 2026-06-18: Gemini CLI is for Code Assist and paid keys.
    [GeminiCliId]: { account: "enterpriseOrKey", provider: "Gemini Code Assist" },
    // Qwen OAuth's free tier ended on 2026-04-15.
    "qwen-code": { account: "subscriptionOrKey", provider: "Alibaba Cloud Coding Plan" },
    kimi: { account: "subscription", provider: "Kimi" },
    antigravity: { account: "accountFree", provider: "Google" },
    copilot: { account: "accountFree", provider: "GitHub Copilot" },
    cursor: { account: "subscription", provider: "Cursor" },
    // xAI's page names no plan: a browser sign-in or an xAI API key.
    grok: { account: "accountOrKey", provider: "xAI" },
    vibe: { account: "accountFree", provider: "Mistral" },
};

// A subscription that runs in Claude Code through its vendor's Anthropic-compatible endpoint: the recipe sets the two
// variables, the vendor's page (linked) gives the model variables, since their model names change. Shown and copied,
// never written anywhere by MoltenTerm.
export type AgentRecipe = {
    id: string;
    name: string;
    provider: string;
    account: AccountKind;
    guideUrl: string;
    signInPage: string;
    lines: string[];
};

function claudeRecipe(baseUrl: string, keyPlaceholder: string): string[] {
    return [`export ANTHROPIC_BASE_URL=${baseUrl}`, `export ANTHROPIC_AUTH_TOKEN=${keyPlaceholder}`, "claude"];
}

// Checked on 2026-11-01 (#1680): Z.ai's Claude Code page (international endpoint; mainland China uses
// open.bigmodel.cn, on the same page's Chinese twin) and MiniMax's (api.minimax.io; api.minimax.cn in mainland China;
// its Coding and Token plans are now the M Plan).
// DeepSeek's recipe left the first launch with #1680: it needs an API key, not a subscription.
export const Recipes: AgentRecipe[] = [
    {
        id: GlmCardId,
        name: "GLM Coding Plan",
        provider: "Z.ai",
        account: "planKey",
        guideUrl: "https://docs.z.ai/devpack/tool/claude",
        signInPage: "https://z.ai/subscribe",
        lines: claudeRecipe("https://api.z.ai/api/anthropic", "<your GLM Coding Plan key>"),
    },
    {
        id: MiniMaxCardId,
        name: "MiniMax M Plan",
        provider: "MiniMax",
        account: "planKey",
        guideUrl: "https://platform.minimax.io/docs/coding-plan/claude-code",
        signInPage: "https://www.minimax.io/m-plan",
        lines: claudeRecipe("https://api.minimax.io/anthropic", "<your MiniMax M Plan key>"),
    },
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
    // the vendor's page to sign in or create an account and pick a plan (#1680)
    signInPage?: string;
    // wavesrv saw the agent's sign-in (a credentials file it documents); false when it cannot tell
    signedIn?: boolean;
    // the agent a recipe runs in (Claude Code)
    agentName?: string;
    // a recipe card: Configure shows the recipe's lines rather than an install command
    recipe?: boolean;
    recipeLines?: string[];
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
        install: agent.installcommands ?? [],
        installPage: agent.installpage,
        signInPage: agent.signinpage,
        signedIn: !!agent.signedin,
        hooksNote: agent.id === CodexId,
    };
}

function recipeCard(recipe: AgentRecipe, list: OnboardingAgents): PourAgentCard {
    const claude = (list?.agents ?? []).find((a) => a.id === ClaudeCodeId);
    return {
        id: recipe.id,
        name: recipe.name,
        command: claude?.executable || "claude",
        agentName: claude?.name || "Claude Code",
        ready: false,
        full: false,
        account: recipe.account,
        provider: recipe.provider,
        install: [],
        installPage: recipe.guideUrl,
        signInPage: recipe.signInPage,
        recipe: true,
        recipeLines: recipe.lines,
    };
}

// Every card is equal: the agents found on this computer first, then all the others, recipes included, by name. Gemini
// CLI shows only when found (Antigravity CLI has the card for personal Google accounts).
export function pourAgentCards(list: OnboardingAgents): PourAgentCard[] {
    if (list == null) {
        return [];
    }
    const agents = catalogAgents(list).filter((a) => a.found || a.id !== GeminiCliId);
    const found = agents.filter((a) => a.found).map(agentCard);
    const others = [...agents.filter((a) => !a.found).map(agentCard), ...Recipes.map((r) => recipeCard(r, list))].sort(
        (a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })
    );
    return [...found, ...others];
}

// A found agent whose sign-in MoltenTerm did not see: its card offers the sign-in step.
export function needsSignIn(card: PourAgentCard): boolean {
    return card != null && !card.recipe && card.ready && !card.signedIn;
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
