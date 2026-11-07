// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The plan usage Brokk's group tells (FR-BOSS-009, AC17 and AC20, FR-BOSS-006, #2032): under the square, the weekly window
// of each provider that shares a reading, in percent; behind a click on that block, the detail of every window the
// former Usage tab listed. Pure, so the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { GaugeRow, gaugeRows, UsageSnapshot, UsageWindow } from "../companion/companion-gauges-model";
import type { UsageReadings } from "./boss-usage";

export const WeekWindowId = "week";
// A window known only by its length: seven days.
const WeekMins = 7 * 24 * 60;

// The bar turns grave above this percent.
export const GravePercent = 90;

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

export type WeeklyUsage = {
    provider: string;
    // Rounded, as shown.
    percent: number;
    grave: boolean;
    // When the week window resets (Unix ms), 0 when the reader does not say.
    resetsAt: number;
};

function isWeek(window: UsageWindow): boolean {
    return window.id === WeekWindowId || window.windowmins === WeekMins;
}

// The weekly window of each provider, the fullest first. A provider with no weekly reading, or whose week is past its
// reset, has no entry.
export function weeklyUsage(readings: UsageReadings, now: number): WeeklyUsage[] {
    const out: WeeklyUsage[] = [];
    for (const [provider, snapshot] of latestByProvider(readings)) {
        const week = (snapshot.windows ?? []).find(
            (w) => w != null && isWeek(w) && Number.isFinite(w.usedpercent) && !(w.resetsat > 0 && w.resetsat <= now)
        );
        if (week == null) {
            continue;
        }
        const percent = Math.round(Math.min(100, Math.max(0, week.usedpercent)));
        out.push({ provider, percent, grave: percent > GravePercent, resetsAt: week.resetsat ?? 0 });
    }
    return out.sort((a, b) => b.percent - a.percent || (a.provider < b.provider ? -1 : 1));
}

// The weekday the week resets on, in the language given ("lundi"); "" when the reader does not say.
export function resetDay(resetsAt: number, locale: string): string {
    if (!resetsAt || resetsAt <= 0) {
        return "";
    }
    return new Date(resetsAt).toLocaleDateString(locale, { weekday: "long" });
}
