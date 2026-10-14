// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Preconfigured morphs: ready /morph requests MoltenTerm offers for a personal change it does not ship, each backed by
// a guide in `molten docs` that the developer's own agent follows (pkg/molten/agentdocs/morph.md, "Preconfigured
// morphs"). MoltenTerm ships a base; what is personal to the developer comes through one of these. The language
// pack is the first (FR-I18N-002, DS-I18N-009). The requests stay English: the agent reads them.

export type MorphTemplate = {
    id: string;
    // The guide in the `molten docs` folder the agent follows for this kind of request.
    guide: string;
};

export const LanguagePackTemplate: MorphTemplate = { id: "language-pack", guide: "language-pack.md" };

export const MorphTemplates: MorphTemplate[] = [LanguagePackTemplate];

// What the developer pastes into their agent to add a language they name.
export function addLanguageRequest(language?: string): string {
    return `/morph translate MoltenTerm into ${language?.trim() || "<language>"}`;
}

// What completes a pack an update left partly untranslated (DS-I18N-011).
export function completeLanguageRequest(name: string, code: string): string {
    return `/morph complete the ${name} (${code}) translation of MoltenTerm`;
}
