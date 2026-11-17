// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the downloads, the update notice and the plan usage tell Brokk's visit model (FR-BOSS-009, AC11, #2003): the
// adapters between the stores the window holds and the events of brokk-visit-events.ts. Each one raises an event while
// the fact holds and the developer has not opened Brokk since; opening him acknowledges what he saw. The security alert
// is #2004's. Pure, so the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { gaugeRows, UsageSnapshot } from "../companion/companion-gauges-model";
import { DownloadRecord } from "../downloads/downloads-model";
import { checkUnread, MoltentermNotification } from "../notifications-model";
import { readingStale } from "../usage-week/usage-week-model";
import type { UsageReadings } from "./boss-usage";
import { hiddenReason, UsageContext } from "./brokk-usage-model";
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

const NoDownloads: ReadonlySet<string> = new Set();

// `closed`: the downloads whose notification the developer settled or cleared (#2026): handled, so no news either.
export function downloadEventsOf(
    memory: DownloadsMemory,
    items: DownloadRecord[],
    closed: ReadonlySet<string> = NoDownloads
): BrokkEvent[] {
    return overItems(items, memory.floor)
        .filter((item) => !memory.known.has(item.id) && !closed.has(item.id))
        .map((item) => ({
            key: `download:${item.id}`,
            kind: item.state === "completed" ? ("downloadfinished" as const) : ("downloadfailed" as const),
            since: item.endedAt,
        }));
}

// must match downloadNotificationKey in downloads/downloads-notify.ts, which this file does not import (it is part of the
// bubble's up-front JavaScript)
const DownloadNoticePrefix = "download:";

// The downloads whose notification is resolved or archived: the developer settled or cleared it.
export function closedDownloadIds(
    notices: { key?: string; resolved?: number; archived?: number }[]
): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const notice of notices ?? []) {
        if (notice.key?.startsWith(DownloadNoticePrefix) && (notice.resolved != null || notice.archived != null)) {
            ids.add(notice.key.slice(DownloadNoticePrefix.length));
        }
    }
    return ids;
}

// The developer opened Brokk: what is over is seen.
export function acknowledgeDownloads(memory: DownloadsMemory, items: DownloadRecord[]): DownloadsMemory {
    return {
        floor: memory.floor,
        known: new Set([...memory.known, ...overItems(items, memory.floor).map((item) => item.id)]),
    };
}

// ---- the update notice ------------------------------------------------------------------------------------------------

// The update's card in the Notifications panel (#2213): the badge counts the offer only while that card is listed and
// unread, whatever the view, so that the badge never leads to a panel without it. `cardKey` is the key of the offer's
// notification; "" when no card stands for it.
export function listedUpdateCard(cardKey: string, entries: MoltentermNotification[]): string {
    if (!cardKey) {
        return "";
    }
    return (entries ?? []).some((entry) => entry.key === cardKey && checkUnread(entry)) ? cardKey : "";
}

// `offer` names the update on offer ("" for none): its card's key (listedUpdateCard). `seen` is the one the developer
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

// The seen providers survive a restart (#2223): kept in the local storage of this computer.
export const UsageSeenKey = "moltenterm:brokk-usage-seen";

export function readUsageMemory(raw: string): UsageMemory {
    try {
        const value = JSON.parse(raw ?? "");
        return Array.isArray(value) ? { seen: new Set(value.filter((p) => typeof p === "string")) } : EmptyUsageMemory;
    } catch {
        return EmptyUsageMemory;
    }
}

export function usageMemoryText(memory: UsageMemory): string {
    return JSON.stringify([...memory.seen].sort());
}
