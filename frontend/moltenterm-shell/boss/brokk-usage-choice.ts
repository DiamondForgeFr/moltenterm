// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The developer's choice of which providers Brokk's usage grid shows (FR-BOSS-009, AC97, #2341), as the settings
// boss:usageshow and boss:usagehide hold it: "Always show" pins a provider, "Hide" turns one away, "Automatic" gives it
// back to the rules. Pure and tiny: the hub reads it up front; the rules, the grid and the menu that change it load on
// demand (NFR-PERF-003, bundle.initialJsMB).

// The providers the developer pinned and the ones he turned away.
export type UsageChoices = { show: string[]; hide: string[] };
export type UsageChoice = "show" | "hide" | "auto";

// The lists as the settings hold them: anything that is not a list of ids is no choice.
export function choicesOf(show: unknown, hide: unknown): UsageChoices {
    const ids = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id !== "") : [];
    return { show: ids(show), hide: ids(hide) };
}

export function choiceOf(choices: UsageChoices, provider: string): UsageChoice {
    if (choices?.show?.includes(provider)) {
        return "show";
    }
    return choices?.hide?.includes(provider) ? "hide" : "auto";
}
