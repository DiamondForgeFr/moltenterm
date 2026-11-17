// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// When a plan usage calls Brokk (FR-BOSS-009, AC11, #2003, #2223; AC95 to AC97, #2341): the providers whose fullest window
// is at the line or above it, among those his usage grid shows, and the events that raise. A reading too old to be
// current, a provider the developer chose to hide and one left out for want of use never bring him. Pure, so the rules are
// tested without a window.
//
// It loads on demand: the hub's feeds ask for it when a reading first comes (brokk-hub-feed-store.ts), outside the
// JavaScript every view loads up front (NFR-PERF-003, bundle.initialJsMB).

import { gaugeRows, UsageSnapshot } from "../companion/companion-gauges-model";
import { readingStale } from "../usage-week/usage-week-stale";
import type { UsageReadings } from "./boss-usage";
import { EmptyUsageMemory, UsageMemory, UsageThresholdPercent } from "./brokk-extra-feeds";
import { hiddenReason, UsageContext } from "./brokk-usage-model";
import type { BrokkEvent } from "./brokk-visit-events";

// The latest reading of each provider that the usage grid shows: several agents of one provider share its plan. A
// provider the developer chose to hide, or that was not used for 7 days on a plan that is not paid, is not shown, and so
// is not told of: it never calls him (AC95 and AC97, #2341). `ctx` is what the grid reads (its use and the choices); none
// leaves every provider shown.
function shownReadings(readings: UsageReadings, now: number, ctx?: UsageContext): Map<string, UsageSnapshot> {
    const latest = new Map<string, UsageSnapshot>();
    for (const [agent, snapshot] of Object.entries(readings ?? {})) {
        if (snapshot == null) {
            continue;
        }
        const provider = snapshot.agent || agent;
        if ((latest.get(provider)?.readat ?? -1) > (snapshot.readat ?? 0)) {
            continue;
        }
        latest.set(provider, snapshot);
    }
    for (const [provider, snapshot] of latest) {
        if (hiddenReason(provider, snapshot.plan ?? "", snapshot.readat ?? 0, ctx, now) !== "") {
            latest.delete(provider);
        }
    }
    return latest;
}

// The providers whose fullest window is at the line or above it, among those the grid shows. A reading too old to be
// current (AC96, #2341) is no news: it never calls him.
export function hotProviders(readings: UsageReadings, now: number, ctx?: UsageContext): string[] {
    return [...shownReadings(readings, now, ctx).entries()]
        .filter(([, snapshot]) => {
            if (readingStale(snapshot, now)) {
                return false;
            }
            return Math.max(0, ...gaugeRows(snapshot, now).map((row) => row.bar)) >= UsageThresholdPercent;
        })
        .map(([provider]) => provider);
}

// A provider leaves `seen` only once a reading says it is below the line: the readings come in a while after a start,
// and a provider not read yet is not a provider that cooled down (#2223). A provider the grid does not show is not read:
// what he had seen of it stays seen while it is hidden.
export function usageEventsAfter(
    memory: UsageMemory,
    readings: UsageReadings,
    now: number,
    ctx?: UsageContext
): { memory: UsageMemory; events: BrokkEvent[] } {
    const hot = hotProviders(readings, now, ctx);
    const read = shownReadings(readings, now, ctx);
    const seen = new Set([...memory.seen].filter((provider) => hot.includes(provider) || !read.has(provider)));
    const events = hot
        .filter((provider) => !seen.has(provider))
        .map((provider) => ({ key: `usage:${provider}`, kind: "usage" as const, since: 0 }));
    return { memory: seen.size === memory.seen.size ? memory : { seen }, events };
}

// The developer opened Brokk: what is hot now is seen, and so stays what was seen and is not read yet.
export function acknowledgeUsage(
    readings: UsageReadings,
    now: number,
    memory: UsageMemory = EmptyUsageMemory,
    ctx?: UsageContext
): UsageMemory {
    const read = shownReadings(readings, now, ctx);
    const kept = [...memory.seen].filter((provider) => !read.has(provider));
    return { seen: new Set([...kept, ...hotProviders(readings, now, ctx)]) };
}
