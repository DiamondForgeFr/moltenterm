// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Scene 2's cards from the real detection (FR-ONB-007 AC-4, AC-5).

import { describe, expect, it } from "vitest";
import type { OnboardingAgent, OnboardingAgents } from "./onboarding-agent-model";
import {
    foundSentenceKey,
    GlmCardId,
    headlineAgentNames,
    keptAgent,
    MiniMaxCardId,
    needsSignIn,
    newlyReady,
    pourAgentCards,
    readyCount,
    Recipes,
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
        installcommands: [`install ${id}`, `npm i -g ${id}`],
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
        agent("antigravity", "Antigravity CLI", "agy", false),
        agent("copilot", "GitHub Copilot CLI", "copilot", false),
        agent("cursor", "Cursor CLI", "agent", false),
        agent("grok", "Grok Build", "grok", false),
        agent("vibe", "Mistral Vibe", "vibe", false),
        agent("generic", "Generic coding agent", "", false),
    ],
};

describe("the agent cards (FR-ONB-007)", () => {
    const cards = pourAgentCards(List);

    it("shows the agents found first, then every other card by name, never ranked by vendor (#1680)", () => {
        expect(cards.map((c) => c.id)).toEqual([
            "claude-code",
            "codex",
            "antigravity",
            "cursor",
            "copilot",
            "glm",
            "grok",
            "kimi",
            "minimax",
            "vibe",
            "qwen-code",
        ]);
        expect(readyCount(cards)).toBe(2);
    });

    it("keeps Gemini CLI's card only for those who have it (Antigravity CLI took over personal accounts)", () => {
        expect(cards.some((c) => c.id === "gemini-cli")).toBe(false);
        const withGemini = pourAgentCards({
            ...List,
            agents: List.agents.map((a) => (a.id === "gemini-cli" ? { ...a, found: true } : a)),
        });
        expect(withGemini.find((c) => c.id === "gemini-cli")).toMatchObject({
            ready: true,
            account: "enterpriseOrKey",
        });
    });

    it("says which account each new agent needs", () => {
        const account = (id: string) => cards.find((c) => c.id === id)?.account;
        expect(account("antigravity")).toBe("accountFree");
        expect(account("copilot")).toBe("accountFree");
        expect(account("cursor")).toBe("subscription");
        expect(account("grok")).toBe("accountOrKey");
        expect(account("vibe")).toBe("accountFree");
    });

    it("gives each its command, readiness and integration level", () => {
        const claude = cards.find((c) => c.id === "claude-code");
        expect(claude).toMatchObject({ command: "claude", ready: true, full: true });
        const kimi = cards.find((c) => c.id === "kimi");
        expect(kimi).toMatchObject({ command: "kimi", ready: false, full: false, account: "subscription" });
        expect(kimi.installPage).toBe("https://example.invalid/kimi");
    });

    it("shows wavesrv's catalog commands, the one Install runs first (#1667)", () => {
        expect(cards.find((c) => c.id === "kimi").install).toEqual(["install kimi", "npm i -g kimi"]);
        const bare = pourAgentCards({
            version: "1",
            agents: [agent("kimi", "Kimi Code", "kimi", false, { installcommands: undefined })],
        });
        expect(bare[0].install).toEqual([]);
    });

    it("reminds to approve Codex's hooks in /hooks", () => {
        expect(cards.filter((c) => c.hooksNote).map((c) => c.id)).toEqual(["codex"]);
    });

    it("offers GLM Coding Plan and MiniMax as Claude Code recipes, and no DeepSeek card (#1680)", () => {
        expect(cards.some((c) => c.id === "deepseek")).toBe(false);
        const glm = cards.find((c) => c.id === GlmCardId);
        expect(glm).toMatchObject({ recipe: true, ready: false, command: "claude", account: "planKey" });
        expect(glm.recipeLines).toContain("export ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic");
        const minimax = cards.find((c) => c.id === MiniMaxCardId);
        expect(minimax.recipeLines).toContain("export ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic");
        for (const r of Recipes) {
            expect(r.lines.at(-1)).toBe("claude");
            expect(r.signInPage).toMatch(/^https:\/\//);
            expect(r.guideUrl).toMatch(/^https:\/\//);
        }
    });

    it("offers the sign-in step to a found agent whose sign-in MoltenTerm did not see", () => {
        const signed = pourAgentCards({
            ...List,
            agents: List.agents.map((a) =>
                a.id === "codex" ? { ...a, signedin: true, signinpage: "https://example.invalid/in" } : a
            ),
        });
        expect(needsSignIn(signed.find((c) => c.id === "codex"))).toBe(false);
        expect(needsSignIn(signed.find((c) => c.id === "claude-code"))).toBe(true);
        expect(needsSignIn(signed.find((c) => c.id === "kimi"))).toBe(false);
        expect(needsSignIn(signed.find((c) => c.id === "glm"))).toBe(false);
        expect(signed.find((c) => c.id === "codex").signInPage).toBe("https://example.invalid/in");
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
