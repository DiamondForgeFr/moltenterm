// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// MoltenTerm is provider-agnostic (FR-I18N-001 AC11, #1452): you connect any agent CLI or model to it, so a sentence
// never names Claude, Codex, Anthropic, OpenAI, GPT or Gemini as a fixed word. An agent is named by its first name, a
// page by its title; a provider that has to show is data an adapter supplies (the tool chip of an agent, a usage
// source, the target of an "Open usage" link) and reaches the sentence as a {placeholder}. A key goes in
// ProviderSubjectKeys only when the provider or its product is the subject of the text itself.

import { describe, expect, it } from "vitest";
import { availableLanguageCodes, flattenKeys, resolveKey, shippedDictionary } from "./i18n-core";

// A name inside a file path (".claude/settings.json") is a folder, not a sentence naming a provider.
export const ProviderWords = /(?<![./\w])(claude|codex|anthropic|openai|chatgpt|gpt|gemini|kimi|qwen)(?!\w)/i;

// key → why naming the provider is right there.
export const ProviderSubjectKeys: Record<string, string> = {
    // The names of the agent tools in a choice: the adapter's own name for itself.
    "settings.items.agent:integrateoff.options.claude": "the tool's own name, as a choice",
    "settings.items.agent:integrateoff.options.codex": "the tool's own name, as a choice",
    "settings.items.companion:usagegauges.options.claude": "the tool's own name, as a choice",
    "settings.items.companion:usagegauges.options.codex": "the tool's own name, as a choice",
    "settings.items.moltenterm:codingagent.options.claude": "the tool's own name, as a choice",
    "settings.items.moltenterm:codingagent.options.codex": "the tool's own name, as a choice",
    // The tool that made a worktree, shown as a chip beside the other tools that make worktrees.
    "mc.branches.tool.claudeCode": "names the tool that made a worktree",
    "mc.branches.tool.codex": "names the tool that made a worktree",
    // The setting is the Claude Code adapter's own: it reads that tool's sign-in against that provider's endpoint.
    "settings.items.companion:usageclaudeoauth.label": "the setting belongs to one adapter's undocumented endpoint",
    "settings.items.companion:usageclaudeoauth.description": "the setting belongs to one adapter's undocumented endpoint",
    // A mod's Claude Code part is a plugin of that product: the trust prompt must say what runs where.
    "molten.trust.partWarning": "the part is a Claude Code plugin",
    "molten.trust.partTitle": "the part is a Claude Code plugin",
    "molten.trust.partIntro": "the part is a Claude Code plugin",
    "molten.trust.fieldPart": "the part is a Claude Code plugin",
    "molten.trust.partWrittenFor": "the part targets a Claude Code version",
};

export function providerWordProblems(entries: [string, string][]): string[] {
    return entries
        .filter(([key, text]) => ProviderSubjectKeys[key] == null && ProviderWords.test(text))
        .map(([key, text]) => `${key}: ${text}`);
}

describe("provider-neutral words (#1452)", () => {
    it("catches the provider names", () => {
        expect(providerWordProblems([["a", "Start Claude Code here"]])).toHaveLength(1);
        expect(providerWordProblems([["a", "claude and codex get the hooks"]])).toHaveLength(1);
        expect(providerWordProblems([["a", "Anthropic refused the token"]])).toHaveLength(1);
        expect(providerWordProblems([["a", "Open claude.ai in the browser"]])).toHaveLength(1);
        expect(providerWordProblems([["a", "Powered by GPT-5"]])).toHaveLength(1);
        expect(providerWordProblems([["a", "Ask Gemini"]])).toHaveLength(1);
        expect(providerWordProblems([["a", "Start the agent here"]])).toEqual([]);
        expect(providerWordProblems([["a", "or in a project's .claude/settings.json"]])).toEqual([]);
        expect(providerWordProblems([["a", "Jérôme · {tool} is working"]])).toEqual([]);
    });

    it("keeps the allow-list short and reasoned", () => {
        expect(Object.values(ProviderSubjectKeys).every((why) => why.length > 0)).toBe(true);
        expect(Object.keys(ProviderSubjectKeys).length).toBeLessThanOrEqual(20);
    });

    for (const code of availableLanguageCodes().filter((c) => shippedDictionary(c) != null)) {
        it(`${code}.json names no AI provider outside its allow-list`, () => {
            const dict = shippedDictionary(code);
            const entries = flattenKeys(dict).map((k) => [k, resolveKey(dict, k)] as [string, string]);
            expect(providerWordProblems(entries)).toEqual([]);
        });

        it(`${code}.json has no allow-listed key that no longer names a provider`, () => {
            const dict = shippedDictionary(code);
            const stale = Object.keys(ProviderSubjectKeys).filter((key) => {
                const text = resolveKey(dict, key);
                return text == null || !ProviderWords.test(text);
            });
            expect(stale).toEqual([]);
        });
    }
});
