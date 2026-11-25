// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The picture of an agent's card in the Library starts with its provider's own mark (#2542, FR-BOSS-009 AC113); an
// agent without one, or an agent the catalogue holds as a recipe, keeps the generic agents glyph.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OnboardingAgent } from "../../moltenterm-onboarding/onboarding-agent-model";
import type { PourAgentCard } from "../../moltenterm-onboarding/onboarding-pour-agents";
import type { LibraryAgent } from "./agents-model";
import { AgentCard } from "./agents-section";

function libraryAgent(id: string, name: string, command: string): LibraryAgent {
    const card: PourAgentCard = {
        id,
        name,
        command,
        ready: true,
        full: true,
        account: "subscriptionOrKey",
        provider: name,
        install: [],
    };
    return { card, agent: { id, name } as OnboardingAgent };
}

const html = (id: string, name: string, command: string) =>
    renderToStaticMarkup(<AgentCard row={libraryAgent(id, name, command)} job={undefined} />);
const pic = (markup: string) => /<i class="mt-lib-pic"[^>]*>([\s\S]*?)<\/i>/.exec(markup)?.[1] ?? "";

describe("an agent card's picture", () => {
    it("is the provider's own mark for the agents that have one, the catalogue's ids included", () => {
        for (const [id, name, command, mark] of [
            ["claude-code", "Claude Code", "claude", "claude"],
            ["codex", "Codex", "codex", "codex"],
            ["cursor", "Cursor CLI", "agent", "cursor"],
        ]) {
            const markup = html(id, name, command);
            expect(pic(markup), id).toContain(`data-mark="${mark}"`);
            expect(pic(markup), id).toContain("<img ");
            expect(markup, id).toContain(`>${name}<`);
        }
    });

    it("stays the generic agents glyph for the agents without a mark and for a recipe", () => {
        for (const [id, name, command] of [
            ["kimi", "Kimi Code", "kimi"],
            ["gemini-cli", "Gemini CLI", "gemini"],
            ["glm", "GLM", "claude"],
        ]) {
            const picture = pic(html(id, name, command));
            expect(picture, id).not.toContain("<img ");
            expect(picture, id).not.toContain("provider-mark");
            expect(picture, id).toContain("<svg");
        }
    });
});
