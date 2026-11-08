// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The plan usage Brokk's group tells (FR-BOSS-009, AC17 and AC20, FR-BOSS-006, #2032): under the square, a week grid with
// the main window of each provider that shares a reading (AC48 to AC51, #2100); behind a click on that block, the detail
// of every window the former Usage tab listed. Pure, so the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { GaugeRow, gaugeRows, UsageSnapshot, UsageWindow } from "../companion/companion-gauges-model";
import type { UsageReadings, UsageUnreadable } from "./boss-usage";

export const WeekWindowId = "week";
// A window known only by its length: seven days.
const WeekMins = 7 * 24 * 60;

// A window this full reads as far ahead of its pace when the pace cannot be told (#2100).
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

// A reading older than this shows its age beside its percent (#2074).
export const UsageOldMs = 60 * 60 * 1000;

// The pace colours' steps (#2100), as consumed / allowed: orange is reached at PaceOrangeAt, red at PaceRedAt.
export const PaceOrangeAt = 1.15;
export const PaceRedAt = 1.6;
// Right after a reset nothing is allowed yet: the share allowed never reads below this, so the ratio stays finite.
const MinAllowedPercent = 0.5;

const DaysInWeek = 7;

export type WeeklyUsage = {
    provider: string;
    // Rounded, as shown.
    percent: number;
    // Consumed against what the time gone since the last reset allows (#2100): 1 is on pace.
    pace: number;
    // When the main window resets (Unix ms), 0 when the reader does not say.
    resetsAt: number;
    // The main window's length in minutes, 0 when unknown.
    windowMins: number;
    // When the reading was taken (Unix ms), 0 when unknown.
    readAt: number;
    // The reading is older than UsageOldMs: its age is told.
    old: boolean;
    // Set when the provider's global reading cannot be read at all: the cell says so in one calm line.
    unreadable?: string;
};

const SessionWindowId = "session";
const SpendWindowId = "spend";
const ModelWindowPrefix = "model:";
const SessionMins = 5 * 60;

// A window's length: the one the reader gave, else the one its id names. The per-model and spend windows are no
// provider's main window: they have none.
function windowLength(window: UsageWindow): number {
    if (window.id === SpendWindowId || window.id?.startsWith(ModelWindowPrefix)) {
        return -1;
    }
    if (window.windowmins > 0) {
        return window.windowmins;
    }
    if (window.id === WeekWindowId) {
        return WeekMins;
    }
    if (window.id === SessionWindowId) {
        return SessionMins;
    }
    return 0;
}

// The provider's main window: its longest running one, whatever its length (a week, 30 days…), so every provider that
// reads one has a row (#2100). A reading whose only window is the 5-hour session shows that one.
function mainWindow(snapshot: UsageSnapshot, now: number): UsageWindow {
    let best: UsageWindow = null;
    let bestLength = -1;
    for (const w of snapshot.windows ?? []) {
        if (w == null || !Number.isFinite(w.usedpercent) || (w.resetsat > 0 && w.resetsat <= now)) {
            continue;
        }
        const length = windowLength(w);
        if (length < 0 || length <= bestLength) {
            continue;
        }
        best = w;
        bestLength = length;
    }
    return best;
}

// The pace of a window (#2100): what it consumed against what the time gone since its last reset allows (two days into a
// week allow 28.5 %). Without a reset time or a length the pace is unknown: a nearly spent window reads as far ahead,
// any other as on pace.
export function paceRatio(percent: number, resetsAt: number, windowMins: number, now: number): number {
    if (!(resetsAt > 0) || !(windowMins > 0)) {
        return percent > GravePercent ? PaceRedAt * 2 : 1;
    }
    const length = windowMins * 60 * 1000;
    const gone = Math.min(1, Math.max(0, (now - (resetsAt - length)) / length));
    const allowed = Math.max(MinAllowedPercent, gone * 100);
    return percent / allowed;
}

// The colour of a pace, from the theme: on pace or under it, success; a little above, success to warning; towards error
// as the risk of running out before the reset grows.
export function paceColour(ratio: number): string {
    if (!(ratio > 1)) {
        return "var(--color-success)";
    }
    if (ratio <= PaceOrangeAt) {
        const share = Math.round(((ratio - 1) / (PaceOrangeAt - 1)) * 100);
        return `color-mix(in srgb, var(--color-warning) ${share}%, var(--color-success))`;
    }
    if (ratio <= PaceRedAt) {
        const share = Math.round(((ratio - PaceOrangeAt) / (PaceRedAt - PaceOrangeAt)) * 100);
        return `color-mix(in srgb, var(--color-error) ${share}%, var(--color-warning))`;
    }
    return "var(--color-error)";
}

// The main window of each provider, the fullest first (#2100). A provider with no running window has no entry, unless
// its global reading says it cannot be read: it then comes last, without a percent.
export function weeklyUsage(readings: UsageReadings, now: number, unreadable?: UsageUnreadable): WeeklyUsage[] {
    const out: WeeklyUsage[] = [];
    for (const [provider, snapshot] of latestByProvider(readings)) {
        const main = mainWindow(snapshot, now);
        if (main == null) {
            continue;
        }
        const percent = Math.round(Math.min(100, Math.max(0, main.usedpercent)));
        const readAt = snapshot.readat ?? 0;
        const resetsAt = main.resetsat ?? 0;
        const windowMins = Math.max(0, windowLength(main));
        out.push({
            provider,
            percent,
            pace: paceRatio(percent, resetsAt, windowMins, now),
            resetsAt,
            windowMins,
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
            resetsAt: 0,
            windowMins: 0,
            readAt: 0,
            old: false,
            unreadable: unreadable[provider],
        });
    }
    return out;
}

// The weekday the week resets on, in the language given ("lundi"); "" when the reader does not say.
export function resetDay(resetsAt: number, locale: string): string {
    if (!resetsAt || resetsAt <= 0) {
        return "";
    }
    return new Date(resetsAt).toLocaleDateString(locale, { weekday: "long" });
}

// The keys of the week's initials, Monday first in every language (#2100).
export const WeekDayKeys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// The day's place in the calendar week, in local time: 0 for Monday, 6 for Sunday.
export function weekdayIndex(at: number): number {
    return (new Date(at).getDay() + DaysInWeek - 1) % DaysInWeek;
}

// Monday 00:00 of the calendar week that holds `at`, in local time.
export function weekStart(at: number): number {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - weekdayIndex(at));
    return d.getTime();
}

// The block of the reset day: the day the window resets on, or the day it last reset (its reset time less its length),
// when that day falls in the current calendar week; -1 otherwise. The coming reset wins when both do.
export function resetIndex(resetsAt: number, windowMins: number, now: number): number {
    if (!(resetsAt > 0)) {
        return -1;
    }
    const start = weekStart(now);
    const end = new Date(start);
    end.setDate(end.getDate() + DaysInWeek);
    const inWeek = (at: number) => at >= start && at < end.getTime();
    if (inWeek(resetsAt)) {
        return weekdayIndex(resetsAt);
    }
    const last = windowMins > 0 ? resetsAt - windowMins * 60 * 1000 : 0;
    if (last > 0 && inWeek(last)) {
        return weekdayIndex(last);
    }
    return -1;
}

// How full each of the seven day blocks is, from 0 to 1: percent × 7 / 100 blocks, left to right, the last one partly.
export function dayFills(percent: number): number[] {
    const units = (Math.min(100, Math.max(0, percent)) * DaysInWeek) / 100;
    return Array.from({ length: DaysInWeek }, (_, i) => Math.min(1, Math.max(0, units - i)));
}
