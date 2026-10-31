// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Scene 2's cards from the real detection (FR-ONB-007 AC-4, AC-5).

import { describe, expect, it } from "vitest";
import type { OnboardingAgent, OnboardingAgents } from "./onboarding-agent-model";
import {
    DeepSeekCardId,
    DeepSeekRecipe,
    foundSentenceKey,
    headlineAgentNames,
    keptAgent,
    newlyReady,
    pourAgentCards,
    readyCount,
} from "./onboarding-pour-agents";

function agent(id: string, name: string, executable: string, found: boolean, extra: Partial<OnboardingAgent> = {}) {
    return {
        id,
        name,
        executable,
        found,
        path: "",
        invocation: "/morph <request>",
        format: "skill",
        installed: found,
        guides: [],
        installpage: `https://example.invalid/${id}`,
        ...extra,
    } as OnboardingAgent;
}

const List: OnboardingAgents = {
    version: "1.0.0",
    agents: [
        agent("claude-code", "Claude Code", "claude", true),
        agent("codex", "Codex", "codex", true),
        agent("gemini-cli", "Gemini CLI", "gemini", false),
        agent("qwen-code", "Qwen Code", "qwen", false),
        agent("kimi", "Kimi Code", "kimi", false),
        agent("generic", "Generic coding agent", "", false),
    ],
};

describe("the agent cards (FR-ONB-007)", () => {
    const cards = pourAgentCards(List);

    it("shows every catalog agent, found ones first, then DeepSeek, without the generic profile", () => {
        expect(cards.map((c) => c.id)).toEqual(["claude-code", "codex", "gemini-cli", "qwen-code", "kimi", "deepseek"]);
        expect(readyCount(cards)).toBe(2);
    });

    it("gives each its command, readiness and integration level", () => {
        const claude = cards.find((c) => c.id === "claude-code");
        expect(claude).toMatchObject({ command: "claude", ready: true, full: true });
        const kimi = cards.find((c) => c.id === "kimi");
        expect(kimi).toMatchObject({ command: "kimi", ready: false, full: false, account: "subscription" });
        expect(kimi.install[0]).toBe("curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash");
        expect(kimi.installPage).toBe("https://example.invalid/kimi");
    });

    it("installs nothing: the official commands are there to copy", () => {
        expect(cards.find((c) => c.id === "claude-code").install).toEqual([
            "curl -fsSL https://claude.ai/install.sh | bash",
        ]);
        expect(cards.find((c) => c.id === "codex").install[0]).toBe("npm i -g @openai/codex");
        expect(cards.find((c) => c.id === "qwen-code").install[0]).toBe("npm i -g @qwen-code/qwen-code");
        expect(cards.find((c) => c.id === "gemini-cli").install[0]).toBe("npm install -g @google/gemini-cli");
    });

    it("reminds to approve Codex's hooks in /hooks", () => {
        expect(cards.filter((c) => c.hooksNote).map((c) => c.id)).toEqual(["codex"]);
    });

    it("offers DeepSeek as a Claude Code recipe to configure", () => {
        const deepseek = cards.find((c) => c.id === DeepSeekCardId);
        expect(deepseek).toMatchObject({ recipe: true, ready: false, command: "claude", account: "apiKey" });
        expect(DeepSeekRecipe).toContain("export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic");
        expect(DeepSeekRecipe.at(-1)).toBe("claude");
    });

    it("counts the agents found for the sentence above the cards", () => {
        expect(foundSentenceKey(0)).toBe("onboarding.pour.agents.found.none");
        expect(foundSentenceKey(1)).toBe("onboarding.pour.agents.found.one");
        expect(foundSentenceKey(2)).toBe("onboarding.pour.agents.found.other");
    });

    it("names the agent that turned ready at Check again", () => {
        const after = pourAgentCards({
            ...List,
            agents: List.agents.map((a) => (a.id === "kimi" ? { ...a, found: true } : a)),
        });
        expect(newlyReady(cards, after).map((c) => c.id)).toEqual(["kimi"]);
        expect(newlyReady(cards, cards)).toEqual([]);
    });

    it("keeps the first found agent whose /morph works", () => {
        expect(keptAgent(List).id).toBe("claude-code");
        const declined = {
            ...List,
            agents: List.agents.map((a) => (a.id === "claude-code" ? { ...a, declined: true } : a)),
        };
        expect(keptAgent(declined).id).toBe("codex");
        expect(keptAgent({ version: "", agents: [agent("kimi", "Kimi Code", "kimi", false)] })).toBeNull();
    });

    it("waits for the detection and names the headline agents from the catalog", () => {
        expect(pourAgentCards(null)).toEqual([]);
        expect(headlineAgentNames(List)).toEqual(["Claude Code", "Codex"]);
        expect(headlineAgentNames(null)).toEqual(["Claude Code", "Codex"]);
    });
});
