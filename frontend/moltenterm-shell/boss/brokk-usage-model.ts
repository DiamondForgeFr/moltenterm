// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The plan usage Brokk's group tells (FR-BOSS-009, AC17 and AC20, FR-BOSS-006, #2032): under the square, a week grid with
// the main window of each provider that shares a reading (AC48 to AC51, #2100, the shared usage-week grid); behind a
// click on that block, the detail of every window the former Usage tab listed. Pure, so the rules are tested without a
// window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { GaugeRow, gaugeRows, UsageSnapshot } from "../companion/companion-gauges-model";
import { mainWindow, UsageWeekLine, usageWeekLine } from "../usage-week/usage-week-model";
import type { UsageReadings, UsageUnreadable } from "./boss-usage";

export type UsageProvider = {
    // The provider's id: the agent whose reading it is.
    id: string;
    plan: string;
    rows: GaugeRow[];
    // The fullest window, to rank providers.
    fullest: number;
};

// The latest reading of each provider: several agents of one provider share its plan (FR-SHELL-027).
function latestByProvider(readings: UsageReadings): Map<string, UsageSnapshot> {
    const latest = new Map<string, UsageSnapshot>();
    for (const [agent, snapshot] of Object.entries(readings ?? {})) {
        if (snapshot == null) {
            continue;
        }
        const provider = snapshot.agent || agent;
        const held = latest.get(provider);
        if (held == null || (snapshot.readat ?? 0) > (held.readat ?? 0)) {
            latest.set(provider, snapshot);
        }
    }
    return latest;
}

// One entry per provider that gave a reading with a window still running, the fullest first: the detail panel.
export function usageProviders(readings: UsageReadings, now: number): UsageProvider[] {
    const providers: UsageProvider[] = [];
    for (const [id, snapshot] of latestByProvider(readings)) {
        const rows = gaugeRows(snapshot, now);
        if (rows.length === 0) {
            continue;
        }
        providers.push({ id, plan: snapshot.plan ?? "", rows, fullest: Math.max(...rows.map((row) => row.bar)) });
    }
    return providers.sort((a, b) => b.fullest - a.fullest);
}

// A reading older than this shows its age beside its percent (#2074).
export const UsageOldMs = 60 * 60 * 1000;

// A provider's line in the week grid: its main window's, with the reading's age.
export type WeeklyUsage = UsageWeekLine & {
    provider: string;
    // When the reading was taken (Unix ms), 0 when unknown.
    readAt: number;
    // The reading is older than UsageOldMs: its age is told.
    old: boolean;
    // Set when the provider's global reading cannot be read at all: the row says so in one calm line.
    unreadable?: string;
};

// The main window of each provider (its longest running one, a week, 30 days…), the fullest first (#2100). A provider
// with no running window has no entry, unless its global reading says it cannot be read: it then comes last, without a
// percent.
export function weeklyUsage(readings: UsageReadings, now: number, unreadable?: UsageUnreadable): WeeklyUsage[] {
    const out: WeeklyUsage[] = [];
    for (const [provider, snapshot] of latestByProvider(readings)) {
        const main = mainWindow(snapshot.windows, now);
        if (main == null) {
            continue;
        }
        const readAt = snapshot.readat ?? 0;
        out.push({
            ...usageWeekLine(main, now),
            provider,
            readAt,
            old: readAt > 0 && now - readAt > UsageOldMs,
        });
    }
    out.sort((a, b) => b.percent - a.percent || (a.provider < b.provider ? -1 : 1));
    const shown = new Set(out.map((u) => u.provider));
    for (const provider of Object.keys(unreadable ?? {}).sort()) {
        if (shown.has(provider)) {
            continue;
        }
        out.push({
            provider,
            percent: 0,
            pace: 1,
            unused: 0,
            resetsAt: 0,
            windowMins: 0,
            start: -1,
            readAt: 0,
            old: false,
            unreadable: unreadable[provider],
        });
    }
    return out;
}
