// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the downloads, the update notice and the plan usage tell Brokk's visit model (FR-BOSS-009, AC11, #2003): the
// adapters between the stores the window holds and the events of brokk-visit-events.ts. Each one raises an event while
// the fact holds and the developer has not opened Brokk since; opening him acknowledges what he saw. The security alert
// is #2004's. Pure, so the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { gaugeRows } from "../companion/companion-gauges-model";
import { DownloadRecord } from "../downloads/downloads-model";
import type { UsageReadings } from "./boss-usage";
import type { BrokkEvent } from "./brokk-visit-events";

export const DownloadsSource = "downloads";
export const UpdateSource = "update";
export const UsageSource = "usage";

// The plan usage at which Brokk may come (the setting is the row "Plan usage above 90 %").
export const UsageThresholdPercent = 90;

// ---- downloads --------------------------------------------------------------------------------------------------------

// `floor`: when the window began to listen. The history that loads after it ended before it, so it is no news; a download
// that ends later is news, finished or failed. `known`: the ones the developer has seen by opening Brokk. One the
// developer cancelled is no news, and a download in progress is not over.
export type DownloadsMemory = { known: Set<string>; floor: number };

export function makeDownloadsMemory(floor: number): DownloadsMemory {
    return { known: new Set(), floor };
}

function overItems(items: DownloadRecord[], floor: number): DownloadRecord[] {
    return items.filter(
        (item) => (item.state === "completed" || item.state === "interrupted") && item.endedAt >= floor
    );
}

export function downloadEventsOf(memory: DownloadsMemory, items: DownloadRecord[]): BrokkEvent[] {
    return overItems(items, memory.floor)
        .filter((item) => !memory.known.has(item.id))
        .map((item) => ({
            key: `download:${item.id}`,
            kind: item.state === "completed" ? ("downloadfinished" as const) : ("downloadfailed" as const),
            since: item.endedAt,
        }));
}

// The developer opened Brokk: what is over is seen.
export function acknowledgeDownloads(memory: DownloadsMemory, items: DownloadRecord[]): DownloadsMemory {
    return {
        floor: memory.floor,
        known: new Set([...memory.known, ...overItems(items, memory.floor).map((item) => item.id)]),
    };
}

// ---- the update notice ------------------------------------------------------------------------------------------------

// `offer` names the update on offer ("" for none): a gold's build, a release's version. `seen` is the one the developer
// has been shown by opening Brokk; a newer offer is news again.
export function updateEventsOf(offer: string, seen: string): BrokkEvent[] {
    if (offer === "" || offer === seen) {
        return [];
    }
    return [{ key: `update:${offer}`, kind: "update", since: 0 }];
}

// ---- plan usage -------------------------------------------------------------------------------------------------------

// `seen`: the providers whose usage was above the line when the developer last opened Brokk. A provider that falls below
// the line leaves it, so crossing it again is news.
export type UsageMemory = { seen: Set<string> };

export const EmptyUsageMemory: UsageMemory = { seen: new Set() };

// The providers whose fullest window is at the line or above it. Several agents of one provider share its plan: the
// provider takes its latest reading.
export function hotProviders(readings: UsageReadings, now: number): string[] {
    const latest = new Map<string, number>();
    const readAt = new Map<string, number>();
    for (const [agent, snapshot] of Object.entries(readings ?? {})) {
        if (snapshot == null) {
            continue;
        }
        const provider = snapshot.agent || agent;
        if ((readAt.get(provider) ?? -1) > (snapshot.readat ?? 0)) {
            continue;
        }
        readAt.set(provider, snapshot.readat ?? 0);
        latest.set(provider, Math.max(0, ...gaugeRows(snapshot, now).map((row) => row.bar)));
    }
    return [...latest.entries()].filter(([, bar]) => bar >= UsageThresholdPercent).map(([provider]) => provider);
}

export function usageEventsAfter(
    memory: UsageMemory,
    readings: UsageReadings,
    now: number
): { memory: UsageMemory; events: BrokkEvent[] } {
    const hot = hotProviders(readings, now);
    const seen = new Set([...memory.seen].filter((provider) => hot.includes(provider)));
    const events = hot
        .filter((provider) => !seen.has(provider))
        .map((provider) => ({ key: `usage:${provider}`, kind: "usage" as const, since: 0 }));
    return { memory: seen.size === memory.seen.size ? memory : { seen }, events };
}

export function acknowledgeUsage(readings: UsageReadings, now: number): UsageMemory {
    return { seen: new Set(hotProviders(readings, now)) };
}
