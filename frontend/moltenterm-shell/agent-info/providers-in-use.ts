// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Providers in use (FR-AGC-004, FR-BOSS-006, #2431): the one notion every choose-an-agent list and Brokk's usage gauges
// share. An agent is in use when its CLI is installed and it has a trace of use within the window the developer sets in
// Settings (7 days by default): an agent session MoltenTerm started, a hook or completion event, a usage measure. The
// providers in use lead, the most recently used first; an installed one not in use is still offered, folded under
// "Other agents"; an agent that is not installed is not offered at all. Every agent counts the same: nothing here
// prefers one provider, the only default is the one that made a pull request, when the caller names it. Pure, so the
// rules are tested with a fake clock.

export const ProvidersUseDaysKey = "moltenterm:providersusedays";
export const DefaultProvidersUseDays = 7;
export const MaxProvidersUseDays = 30;

const DayMs = 24 * 60 * 60 * 1000;

// The window of recent use in ms, from the days set in Settings; the default for a value that is not a usable count.
export function providersUseWindowMs(days: unknown): number {
    if (typeof days !== "number" || !Number.isFinite(days) || days < 1) {
        return DefaultProvidersUseDays * DayMs;
    }
    return Math.min(Math.round(days), MaxProvidersUseDays) * DayMs;
}

export type ProviderAgent = { id: string; name: string; installed: boolean };

// The last trace of use of a provider (Unix ms), 0 when none is known.
export type LastUseOf = (id: string) => number;

// A provider is in use while its last use is inside the window: a use exactly one window old is no longer in use.
export function inUseWithin(lastUse: number, now: number, windowMs: number): boolean {
    return lastUse > 0 && lastUse > now - windowMs;
}

export type ProviderOrder = {
    // The providers a choice starts from: the preferred one first when it is installed, then the ones in use, the most
    // recently used first.
    shown: ProviderAgent[];
    // The installed providers not in use: still selectable, folded under "Other agents".
    other: ProviderAgent[];
};

// orderProviders ranks the installed agents. `preferred` is the id of the provider a choice leads with (the one that
// made the pull request); it leads when installed, whether or not it is in use. Ties in last use keep the given order,
// the registry's: no provider is preferred by name.
export function orderProviders(
    agents: ProviderAgent[],
    lastUseOf: LastUseOf,
    now: number,
    windowMs: number,
    preferred = ""
): ProviderOrder {
    const installed = (agents ?? []).filter((a) => a?.installed);
    const lead = installed.find((a) => a.id === preferred);
    const ranked = installed
        .filter((a) => a !== lead)
        .map((agent) => ({ agent, lastUse: lastUseOf(agent.id) || 0 }))
        .sort((a, b) => b.lastUse - a.lastUse);
    const inUse = ranked.filter((r) => inUseWithin(r.lastUse, now, windowMs)).map((r) => r.agent);
    const other = ranked.filter((r) => !inUseWithin(r.lastUse, now, windowMs)).map((r) => r.agent);
    return { shown: lead ? [lead, ...inUse] : inUse, other };
}

// The provider a pull request was made by, from the agent name its signature gives ("Claude Code", or "Claude Code via
// GLM" for a run behind a provider): the installed agent of that name, "" when none matches.
export function preferredProviderId(signature: string, agents: ProviderAgent[]): string {
    const name = (signature ?? "").split(" via ")[0].trim().toLowerCase();
    if (name === "") {
        return "";
    }
    const match = (agents ?? []).find((a) => a?.installed && (a.name ?? "").trim().toLowerCase() === name);
    return match?.id ?? "";
}
