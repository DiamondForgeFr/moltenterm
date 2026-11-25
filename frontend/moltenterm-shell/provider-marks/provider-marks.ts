// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The set of provider marks (#2542, FR-BOSS-009 AC113): the one place that says which mark stands for which agent, for
// every surface that shows an agent's identity (the usage rows of Brokk's grid and of the companion's gauges, the agent
// rows of the launcher and of the new view chooser, the Library's agent cards and pages). A surface asks `markOf(agent)`
// and draws the AI icon, or its own generic glyph, when it gets nothing back.
//
// A mark is the provider's own file, unaltered, taken from the provider's brand page and used to name the provider's
// product, never to suggest endorsement. Each entry says where it comes from and under which terms; NOTICE repeats it for
// readers, and provider-marks.test.ts keeps the two in step. An agent without a mark says why (`AgentsWithoutMark`):
// the provider's terms do not allow this use, it offers no mark, or its kit could not be downloaded.

import ClaudeMark from "@/app/asset/claude-color.svg?url";
import CursorCubeDark from "./assets/cursor-cube-2d-dark.svg?url";
import CursorCubeLight from "./assets/cursor-cube-2d-light.svg?url";
import OpenAiBlossomBlack from "./assets/openai-blossom-black.svg?url";
import OpenAiBlossomWhite from "./assets/openai-blossom-white.svg?url";
import OpenCodeLogoDark from "./assets/opencode-logo-dark.svg?url";
import OpenCodeLogoLight from "./assets/opencode-logo-light.svg?url";

export type ProviderMarkInfo = {
    // Who owns the mark.
    provider: string;
    // The file that reads on a dark surface, and the one that reads on a light surface: the provider's own two variants,
    // or the same file when the mark is in colour.
    onDark: string;
    onLight: string;
    // The files as the provider's kit names them, relative to the path in `source` (documentation, and the test that
    // keeps the shipped files and NOTICE together).
    kit: { onDark: string; onLight: string };
    // The files as shipped, under frontend/moltenterm-shell/provider-marks/assets/ (the Claude mark is Wave's own file).
    shipped: { onDark: string; onLight: string };
    // The SHA-256 of each shipped file, which is the provider's file byte for byte: the test fails when a tool or a hand
    // rewrites one (a formatter, an optimiser), since a mark is used as the provider publishes it.
    sha256: { onDark: string; onLight: string };
    // Width over height of the file's canvas.
    ratio: number;
    // The share of the canvas the visible mark spans: some kits draw their mark inside clear space of their own.
    glyph: number;
    // The provider's own minimum height for the mark, in px, 0 when it states none.
    minHeight: number;
    // Where the file comes from, and where the terms of use are.
    source: string;
    terms: string;
};

export const ProviderMarks: Record<string, ProviderMarkInfo> = {
    claude: {
        provider: "Anthropic",
        onDark: ClaudeMark,
        onLight: ClaudeMark,
        kit: { onDark: "claude-color.svg", onLight: "claude-color.svg" },
        shipped: { onDark: "frontend/app/asset/claude-color.svg", onLight: "frontend/app/asset/claude-color.svg" },
        sha256: {
            onDark: "39087116e7a868eef13265337ca486f85ed6ee6e15a0714bf1de6c8d45d00b98",
            onLight: "39087116e7a868eef13265337ca486f85ed6ee6e15a0714bf1de6c8d45d00b98",
        },
        ratio: 1,
        glyph: 1,
        minHeight: 0,
        source: "frontend/app/asset/claude-color.svg, the file Wave Terminal ships for Claude Code (upstream #3046)",
        terms: "https://www.anthropic.com/legal/trademark-guidelines",
    },
    codex: {
        provider: "OpenAI",
        onDark: OpenAiBlossomWhite,
        onLight: OpenAiBlossomBlack,
        kit: {
            onDark: "OpenAI-logos/SVGs/OAI_OpenAI-Blossom_White.svg",
            onLight: "OpenAI-logos/SVGs/OAI_OpenAI-Blossom_Black.svg",
        },
        shipped: {
            onDark: "frontend/moltenterm-shell/provider-marks/assets/openai-blossom-white.svg",
            onLight: "frontend/moltenterm-shell/provider-marks/assets/openai-blossom-black.svg",
        },
        sha256: {
            onDark: "01d158767c4eec0e47bd617e67759c33da0accd1438be1a8d29dfdb99ce87285",
            onLight: "75c1e9fffa5e8c437bec1d67197a73992bca45d166c6ff23215185dea8fae92a",
        },
        ratio: 1,
        glyph: 0.51,
        minHeight: 0,
        source: 'https://cdn.openai.com/brand/openai-logos.zip, the "Download logos" kit of https://openai.com/brand/',
        terms: "https://openai.com/brand/#usage-terms",
    },
    opencode: {
        provider: "Anomaly",
        onDark: OpenCodeLogoDark,
        onLight: OpenCodeLogoLight,
        kit: { onDark: "opencode-logo-transparent-dark.svg", onLight: "opencode-logo-transparent-light.svg" },
        shipped: {
            onDark: "frontend/moltenterm-shell/provider-marks/assets/opencode-logo-dark.svg",
            onLight: "frontend/moltenterm-shell/provider-marks/assets/opencode-logo-light.svg",
        },
        sha256: {
            onDark: "502ff18efbef0432d8a702481669767c0738d744d18c45d6c3bd3b776d2d6a8e",
            onLight: "8fb1cffb7171c85d4c12a8219250f31a397e316b53e94ca14c171452eb3efed7",
        },
        ratio: 0.8,
        glyph: 1,
        minHeight: 20,
        source: "https://opencode.ai/brand/files/, the default variants of https://opencode.ai/brand",
        terms: "https://opencode.ai/brand",
    },
    cursor: {
        provider: "Anysphere",
        onDark: CursorCubeDark,
        onLight: CursorCubeLight,
        kit: { onDark: "General Logos/Cube/SVG/CUBE_2D_DARK.svg", onLight: "General Logos/Cube/SVG/CUBE_2D_LIGHT.svg" },
        shipped: {
            onDark: "frontend/moltenterm-shell/provider-marks/assets/cursor-cube-2d-dark.svg",
            onLight: "frontend/moltenterm-shell/provider-marks/assets/cursor-cube-2d-light.svg",
        },
        sha256: {
            onDark: "cd0e3e5d8991a4cdd4577f8896cd063105207665165c73e25a1ff918dd367eb7",
            onLight: "c483c02f78eb2619778fdd959e72a9adfac4844854472cd2653d4cbfd60e4d71",
        },
        ratio: 0.877,
        glyph: 1,
        minHeight: 0,
        source: "https://ptht05hbb1ssoooe.public.blob.vercel-storage.com/assets/brand/cursor-brand-assets.zip, the asset bundle of https://cursor.com/brand",
        terms: "https://cursor.com/brand",
    },
};

export const ReasonTerms = "terms";
export const ReasonNoMark = "no-mark";
export const ReasonNotObtained = "not-obtained";

export type NoMarkReason = typeof ReasonTerms | typeof ReasonNoMark | typeof ReasonNotObtained;

export type AgentWithoutMark = {
    provider: string;
    reason: NoMarkReason;
    // What was read, where, and what it says.
    source: string;
    note: string;
};

// Every agent of pkg/molten/agentstate.go that has no mark in the set. A new agent is in one list or the other
// (provider-marks.test.ts reads the Go file), so adding one is a decision about its mark, never an oversight.
export const AgentsWithoutMark: Record<string, AgentWithoutMark> = {
    kimi: {
        provider: "Moonshot AI",
        reason: ReasonTerms,
        source: "https://www.kimi.com/policies/logo-usage-terms",
        note: "The logo is licensed solely for editorial, media and non-commercial promotional uses, and may not be recoloured; a row in an application is none of these. Written permission is asked of the brand contact of https://www.kimi.com/resources/kimi-brand.",
    },
    gemini: {
        provider: "Google",
        reason: ReasonNoMark,
        source: "https://about.google/brand-resource-center/",
        note: "No downloadable mark with guidelines for naming the product in third-party software; Google's guidelines keep its product icons for its partners and approved uses.",
    },
    antigravity: {
        provider: "Google",
        reason: ReasonNoMark,
        source: "https://about.google/brand-resource-center/",
        note: "As Gemini CLI: no downloadable mark with guidelines for third-party software.",
    },
    qwen: {
        provider: "Alibaba Cloud",
        reason: ReasonNoMark,
        source: "https://github.com/QwenLM/qwen-code",
        note: "No brand page or kit of the provider was found; the copies of the mark on icon sites are not the provider's own files.",
    },
    copilot: {
        provider: "GitHub",
        reason: ReasonNoMark,
        source: "https://brand.github.com/brand-identity/copilot",
        note: "GitHub's brand toolkit says Copilot has no standalone logo since 2025, and keeps its marks for approved uses.",
    },
    grok: {
        provider: "xAI",
        reason: ReasonNotObtained,
        source: "https://x.ai/legal/brand-guidelines",
        note: "The guidelines and the kit answered HTTP 403 to a program; they were not read in full and no file was taken.",
    },
    vibe: {
        provider: "Mistral AI",
        reason: ReasonNotObtained,
        source: "https://mistral.ai/brand",
        note: "The brand page welcomes partners and collaborators, but its kit (cms.mistral.ai) answered HTTP 403 to a program and offers PNG files only; no file was taken.",
    },
};

// An agent id is the developer's or the provider's text: a name like "constructor" or "__proto__" is no agent of the set.
function has(table: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(table, key);
}

// The ids the agent catalogue of the first launch and of the Library gives three agents (pkg/molten/onboarding/agents.go)
// where pkg/molten/agentstate.go has the short ones.
export const CatalogAliases: Record<string, string> = {
    "claude-code": "claude",
    "gemini-cli": "gemini",
    "qwen-code": "qwen",
};

export function canonicalAgent(agent: string | undefined): string | undefined {
    if (agent != null && has(CatalogAliases, agent)) {
        return CatalogAliases[agent];
    }
    return agent;
}

export function markOf(agent: string | undefined): ProviderMarkInfo | undefined {
    const id = canonicalAgent(agent);
    if (id == null || !has(ProviderMarks, id)) {
        return undefined;
    }
    return ProviderMarks[id];
}

export function withoutMarkOf(agent: string | undefined): AgentWithoutMark | undefined {
    const id = canonicalAgent(agent);
    if (id == null || !has(AgentsWithoutMark, id)) {
        return undefined;
    }
    return AgentsWithoutMark[id];
}

// The agent whose mark a launcher row shows: the row's own id, or the program its command starts when the id is the
// developer's (a preset "agent@work" that runs `claude`). Nothing when neither is an agent with a mark.
export function markAgentOf(id: string | undefined, command?: string): string | undefined {
    if (markOf(id) != null) {
        return id;
    }
    const program = (command ?? "").trim().split(/\s+/)[0];
    return markOf(program) != null ? program : undefined;
}

// The size an agent's mark is drawn at in a square slot of `slot` px: the visible mark fits the slot (its longer side
// is the slot) and never goes under the provider's own minimum height; the file is that size over the share of its
// canvas the mark spans, so a kit's clear space never makes the mark smaller than the others.
export function markSize(mark: ProviderMarkInfo, slot: number): { width: number; height: number } {
    let height = mark.ratio <= 1 ? slot : slot / mark.ratio;
    if (height < mark.minHeight) {
        height = mark.minHeight;
    }
    const canvasHeight = height / mark.glyph;
    return { width: round(canvasHeight * mark.ratio), height: round(canvasHeight) };
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}
