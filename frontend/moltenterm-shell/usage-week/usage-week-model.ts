// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The week grid of a plan usage (FR-BOSS-009, AC48 to AC51, #2100): from the windows a reader gives (FR-SHELL-027), the
// line each one draws under the initials of the calendar week, Monday to Sunday: its rounded percent, the block of its
// last reset (0 %, where the fill starts and runs forward round the week) and its pace (consumed against the share of
// the window elapsed since that reset). Pure and tied to no surface: Brokk's group shows it, and so do the companion's
// gauges (#2102).

import type { UsageWindow } from "../companion/companion-gauges-model";

export const WeekWindowId = "week";
// A window known only by its length: seven days.
const WeekMins = 7 * 24 * 60;
const SessionWindowId = "session";
const SessionMins = 5 * 60;
const SpendWindowId = "spend";
const ModelWindowPrefix = "model:";

// A window this full reads as far ahead of its pace when the pace cannot be told.
export const GravePercent = 90;

// The pace colours' steps, as consumed / allowed: orange is reached at PaceOrangeAt, red at PaceRedAt.
export const PaceOrangeAt = 1.15;
export const PaceRedAt = 1.6;
// The under-use steps (#2106), in points of the allowed share left unused: the colour leaves the normal rule past
// UnusedBlueFrom and is full blue at UnusedBlueAt.
export const UnusedBlueFrom = 10;
export const UnusedBlueAt = 35;
// Right after a reset nothing is allowed yet: the share allowed never reads below this, so the ratio stays finite.
const MinAllowedPercent = 0.5;

const DaysInWeek = 7;
const MinsPerDay = 24 * 60;

// The keys of the week's initials (usageWeek.day.*), Monday first in every language.
export const WeekDayKeys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export type UsageWeekLine = {
    // Rounded, as shown.
    percent: number;
    // Consumed against what the time gone since the last reset allows: 1 is on pace.
    pace: number;
    // What the time gone allowed and the window did not use, in points (unusedPoints, #2106).
    unused: number;
    // When the window resets (Unix ms), 0 when the reader does not say.
    resetsAt: number;
    // The window's length in minutes, 0 when unknown.
    windowMins: number;
    // The block of the last reset, where the fill starts (0 for Monday); -1 without a reset time.
    start: number;
};

function isModelWindow(window: UsageWindow): boolean {
    return window.id?.startsWith(ModelWindowPrefix) === true;
}

// A window's own length, per-model and spend windows included: the one the reader gave, else the one its id names (a
// per-model window is a week, as its label says); 0 when unknown. It sets the window's last reset and its pace.
export function windowLength(window: UsageWindow): number {
    if (window.windowmins > 0) {
        return window.windowmins;
    }
    if (window.id === WeekWindowId || isModelWindow(window)) {
        return WeekMins;
    }
    if (window.id === SessionWindowId) {
        return SessionMins;
    }
    return 0;
}

// A window's length for choosing the main window: -1 for the per-model and spend windows, which are never a provider's
// main window.
export function usageWindowMins(window: UsageWindow): number {
    if (window.id === SpendWindowId || isModelWindow(window)) {
        return -1;
    }
    return windowLength(window);
}

function isRunning(window: UsageWindow, now: number): boolean {
    return window != null && Number.isFinite(window.usedpercent) && !(window.resetsat > 0 && window.resetsat <= now);
}

// The main window of a reading: its longest running one, whatever its length (a week, 30 days…). A reading whose only
// window is the 5-hour session gives that one; none without a running window.
export function mainWindow(windows: UsageWindow[], now: number): UsageWindow {
    let best: UsageWindow = null;
    let bestLength = -1;
    for (const w of windows ?? []) {
        if (!isRunning(w, now)) {
            continue;
        }
        const length = usageWindowMins(w);
        if (length < 0 || length <= bestLength) {
            continue;
        }
        best = w;
        bestLength = length;
    }
    return best;
}

// The weekday a window resets on, in the language given ("lundi"); "" when the reader does not say.
export function resetDay(resetsAt: number, locale: string): string {
    if (!(resetsAt > 0)) {
        return "";
    }
    return new Date(resetsAt).toLocaleDateString(locale, { weekday: "long" });
}

// The day's place in the calendar week, in local time: 0 for Monday, 6 for Sunday.
export function weekdayIndex(at: number): number {
    return (new Date(at).getDay() + DaysInWeek - 1) % DaysInWeek;
}

// The window's last reset: its reset time less its length. Whole days are taken off the calendar, so a change of
// daylight saving time never moves the reset to the day before.
export function lastReset(resetsAt: number, windowMins: number): number {
    if (!(windowMins > 0)) {
        return resetsAt;
    }
    if (windowMins % MinsPerDay !== 0) {
        return resetsAt - windowMins * 60 * 1000;
    }
    const d = new Date(resetsAt);
    d.setDate(d.getDate() - windowMins / MinsPerDay);
    return d.getTime();
}

// The block the fill starts on, the reset day's (0 %): the weekday of the window's last reset, which a weekly window
// shares with its coming one; -1 when the reader gives no reset time.
export function startIndex(resetsAt: number, windowMins: number): number {
    if (!(resetsAt > 0)) {
        return -1;
    }
    return weekdayIndex(lastReset(resetsAt, windowMins));
}

// How full each of the seven day blocks is, Monday to Sunday, from 0 to 1: percent × 7 / 100 blocks, the last one
// partly, starting on the reset day's block and running forward round the week (past Sunday to Monday). Without a
// reset day the fill starts on Monday.
export function dayFills(percent: number, start = 0): number[] {
    const units = (Math.min(100, Math.max(0, percent)) * DaysInWeek) / 100;
    const from = start >= 0 ? start : 0;
    return Array.from({ length: DaysInWeek }, (_, i) => {
        const k = (i - from + DaysInWeek) % DaysInWeek;
        return Math.min(1, Math.max(0, units - k));
    });
}

// The pace of a window: what it consumed against what the time gone since its last reset allows (two days into a week
// allow 28.5 %). Without a reset time or a length the pace is unknown: a nearly spent window reads as far ahead, any
// other as on pace.
export function paceRatio(percent: number, resetsAt: number, windowMins: number, now: number): number {
    const allowed = allowedPercent(resetsAt, windowMins, now);
    if (allowed < 0) {
        return percent > GravePercent ? PaceRedAt * 2 : 1;
    }
    return percent / Math.max(MinAllowedPercent, allowed);
}

// The share of the window the time gone since its last reset allows, in percent; -1 without a reset time or a length.
export function allowedPercent(resetsAt: number, windowMins: number, now: number): number {
    if (!(resetsAt > 0) || !(windowMins > 0)) {
        return -1;
    }
    const last = lastReset(resetsAt, windowMins);
    return Math.min(1, Math.max(0, (now - last) / (resetsAt - last))) * 100;
}

// What the time gone allowed and the window did not use, in percentage points (#2106): tokens that risk being lost
// before the reset. 0 when the pace cannot be told or the window is at or above its pace.
export function unusedPoints(percent: number, resetsAt: number, windowMins: number, now: number): number {
    const allowed = allowedPercent(resetsAt, windowMins, now);
    if (allowed < 0) {
        return 0;
    }
    return Math.max(0, allowed - percent);
}

// The colour of a pace, from the theme: on pace or under it, success; a little above, success to warning; towards error
// as the risk of running out before the reset grows. Far under it (`unused` points past UnusedBlueFrom), success to
// info, full at UnusedBlueAt: the harder it gets to use it all before the reset, the bluer (#2106). Right after a reset
// little is allowed, so the reset day stays green.
export function paceColour(ratio: number, unused = 0): string {
    if (unused > UnusedBlueFrom) {
        const share = Math.round(Math.min(1, (unused - UnusedBlueFrom) / (UnusedBlueAt - UnusedBlueFrom)) * 100);
        return share >= 100 ? "var(--mt-info)" : `color-mix(in srgb, var(--mt-info) ${share}%, var(--color-success))`;
    }
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

// The colours the grid's legend shows (#2123), taken from the rules above so a swatch can never drift from the rows: far
// under the pace is full blue, on pace green, and above it runs from orange to red.
export function legendColours(): { under: string; on: string; above: string } {
    return {
        under: paceColour(1, UnusedBlueAt),
        on: paceColour(1),
        above: `linear-gradient(90deg, ${paceColour(PaceOrangeAt)}, ${paceColour(PaceRedAt)})`,
    };
}

// The line one window draws.
export function usageWeekLine(window: UsageWindow, now: number): UsageWeekLine {
    const percent = Math.round(Math.min(100, Math.max(0, window.usedpercent)));
    const resetsAt = window.resetsat ?? 0;
    const windowMins = windowLength(window);
    return {
        percent,
        pace: paceRatio(percent, resetsAt, windowMins, now),
        unused: unusedPoints(percent, resetsAt, windowMins, now),
        resetsAt,
        windowMins,
        start: startIndex(resetsAt, windowMins),
    };
}

// The line of each running window of a list, in the reader's order: a window past its reset draws none.
export function usageWeekLines(windows: UsageWindow[], now: number): UsageWeekLine[] {
    return (windows ?? []).filter((w) => isRunning(w, now)).map((w) => usageWeekLine(w, now));
}
