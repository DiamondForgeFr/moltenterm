// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Is an agent's intelligence in proportion with its task (#601)? The ticket's complexity label (the sf-workflow's
// `complexity: bug|low|medium|complex`, read by wavesrv, pkg/molten/companion/tickets.go) against the agent's model and
// effort. A hint only: nothing blocks, nothing asks. Pure, so the table is unit tested.

import { t } from "../i18n/i18n";

export type Complexity = "bug" | "low" | "medium" | "complex";

// must match pkg/molten/companion/tickets.go
export const Complexities: Complexity[] = ["bug", "low", "medium", "complex"];

// The proportion table. An agent's power is its model family's tier plus its effort's rank; each complexity fits a
// range of powers, bounds included. Above the range the agent is more than the ticket needs, below it less. A model
// family or an effort missing from these tables gives no hint (Codex's models, a new family): tune them here.
//
//   power = ModelTiers[family] + EffortRanks[effort]      (0 … 6)
//
//   complexity  fits     e.g. fits                       e.g. out of proportion
//   bug         0 … 4    Sonnet · high, Opus · high      Opus · xhigh (over)
//   low         0 … 3    Haiku · high, Opus · medium     Opus · high (over)
//   medium      1 … 5    Sonnet · low, Opus · xhigh      Haiku · low (under), Opus · max (over)
//   complex     3 … 6    Sonnet · high, Opus · medium    Opus · low, Sonnet · medium (under)
export const ModelTiers: Record<string, number> = {
    haiku: 0,
    sonnet: 1,
    opus: 2,
};

export const EffortRanks: Record<string, number> = {
    minimal: 0,
    low: 0,
    medium: 1,
    high: 2,
    xhigh: 3,
    max: 4,
};

export const ComplexityFit: Record<Complexity, { min: number; max: number }> = {
    bug: { min: 0, max: 4 },
    low: { min: 0, max: 3 },
    medium: { min: 1, max: 5 },
    complex: { min: 3, max: 6 },
};

const ModelFamilies = ["opus", "sonnet", "haiku", "fable"];
const FamilyRegex = new RegExp(`\\b(${ModelFamilies.join("|")})\\b`, "i");
// claude-opus-5-5, claude-sonnet-4-5-20250929, claude-opus-4-20250514, claude-3-5-haiku-20241022, with an optional
// context suffix ("[1m]").
const ClaudeIdRegex = new RegExp(
    `^claude-(?:(\\d+)-(\\d+)-)?(${ModelFamilies.join("|")})(?:-(\\d+)(?:-(\\d{1,2}))?)?(?:-\\d{8})?(?:\\[[^\\]]*\\])?$`,
    "i"
);

function capitalize(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

// How a row names a model: "Opus 5.5" for claude-opus-5-5, "Sonnet" for the alias sonnet; any other id as given.
// "inherit" (an Agent call that keeps its parent's model) names none.
export function modelDisplayName(model: string): string {
    const id = (model ?? "").trim();
    if (!id || id.toLowerCase() === "inherit") {
        return "";
    }
    if (ModelFamilies.includes(id.toLowerCase())) {
        return capitalize(id);
    }
    const m = ClaudeIdRegex.exec(id);
    if (m == null) {
        return id;
    }
    const family = capitalize(m[3]);
    const version = m[1] ? `${m[1]}.${m[2]}` : m[4] ? (m[5] ? `${m[4]}.${m[5]}` : m[4]) : "";
    return version ? `${family} ${version}` : family;
}

export function modelFamily(model: string): string {
    const m = FamilyRegex.exec(model ?? "");
    return m == null ? "" : m[1].toLowerCase();
}

export function asComplexity(label: string): Complexity | null {
    const c = (label ?? "").trim().toLowerCase();
    return (Complexities as string[]).includes(c) ? (c as Complexity) : null;
}

export type Proportion = "over" | "under";

export type ProportionHint = { kind: Proportion; label: string; title: string };

// proportionOf tells whether a model and effort are out of proportion with a ticket's complexity; null when they fit
// or when anything is unknown.
export function proportionOf(model: string, effort: string, complexity: string): Proportion | null {
    const c = asComplexity(complexity);
    const tier = ModelTiers[modelFamily(model)];
    const rank = EffortRanks[(effort ?? "").trim().toLowerCase()];
    if (c == null || tier == null || rank == null) {
        return null;
    }
    const power = tier + rank;
    const fit = ComplexityFit[c];
    if (power > fit.max) {
        return "over";
    }
    if (power < fit.min) {
        return "under";
    }
    return null;
}

export function proportionHint(model: string, effort: string, complexity: string): ProportionHint | null {
    const kind = proportionOf(model, effort, complexity);
    if (kind == null) {
        return null;
    }
    const name = modelDisplayName(model) || model;
    const pair = t("companion.proportion.pair", { model: name, effort: effort.trim().toLowerCase() });
    if (kind === "over") {
        return {
            kind,
            label: t("companion.proportion.overLabel", { complexity }),
            title: t("companion.proportion.overTitle", { pair, complexity }),
        };
    }
    return {
        kind,
        label: t("companion.proportion.underLabel", { complexity }),
        title: t("companion.proportion.underTitle", { pair, complexity }),
    };
}
