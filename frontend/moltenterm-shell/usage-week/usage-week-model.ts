// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The week grid of a plan usage (FR-BOSS-009, AC48 to AC51, #2100): from the windows a reader gives (FR-SHELL-027), the
// line each one draws under the initials of the calendar week, Monday to Sunday: its rounded percent, the block of its
// last reset (0 %, where the fill starts and runs forward round the week) and its pace (consumed against the share of
// the window elapsed since that reset). Pure and tied to no surface: Brokk's group shows it, and so do the companion's
// gauges (#2102).

import type { UsageWindow } from "../companion/companion-gauges-model";
import { getLocale, t } from "../i18n/i18n";

export const WeekWindowId = "week";
export const MonthWindowId = "month";
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
    // The used share as the reader gave it, unrounded: a share under 1 % reads "< 1 %" (#2451).
    used?: number;
    // A window that is neither weekly nor deduced (a five-hour session, a month) draws one plain gauge, not the seven
    // days (#2451). The companion sets it (isWeekWindow); Brokk's group draws every provider's main window on the week.
    plain?: boolean;
    // A week deduced from the month (#2451): each day's own use, Monday first, in percent of a seventh of the week;
    // DayUnknown for a day MoltenTerm holds no reading for. Absent for any other window.
    days?: number[];
};

// must match DeducedDayUnknown in pkg/molten/usage/usage.go
export const DayUnknown = -1;

// The narrowest day block a figure fits under without touching its neighbour's: three tabular digits at 11 px ("130")
// and a little air (#2451).
export const MinFigureBlockPx = 24;
// What the grid takes beside its seven blocks: the label column at its widest (6.25rem), the percent (52 px) and the
// eight 3 px gaps between the nine columns.
const GridChromePx = 100 + 52 + 8 * 3;
// The grid width under which the figures go (usage-week.css, @container max-width): below it a block is narrower than
// MinFigureBlockPx.
export const DayFiguresMinGridPx = GridChromePx + 7 * MinFigureBlockPx;

// How wide each day block is in a grid of that width.
export function dayBlockPx(gridPx: number): number {
    return (gridPx - GridChromePx) / 7;
}

// The windows the seven days tell something of: a week (Claude's per-model weeks included) and a week deduced from the
// month. Any other window is a plain gauge (#2451).
export function isWeekWindow(window: UsageWindow): boolean {
    return (
        window.deduced === true ||
        window.id === WeekWindowId ||
        isModelWindow(window) ||
        windowLength(window) === WeekMins
    );
}

// The percent as a row shows it: "< 1 %" for a share above 0 and under 1 %, never "0 %" (#2451).
export function percentText(line: Pick<UsageWeekLine, "percent" | "used">): string {
    if (line.used > 0 && line.used < 1) {
        return t("usageWeek.percentBelowOne");
    }
    return t("usageWeek.percent", { percent: line.percent });
}

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

function mainWindowRank(window: UsageWindow): number {
    if (window.id === MonthWindowId) {
        return Number.POSITIVE_INFINITY;
    }
    return usageWindowMins(window);
}

// A calendar month ranks above a week, a week above a session, without inventing a month duration.
export function mainWindow(windows: UsageWindow[], now: number): UsageWindow {
    let best: UsageWindow = null;
    let bestRank = -1;
    for (const w of windows ?? []) {
        if (!isRunning(w, now)) {
            continue;
        }
        const rank = mainWindowRank(w);
        if (rank < 0 || rank <= bestRank) {
            continue;
        }
        best = w;
        bestRank = rank;
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

export function previousMonthReset(resetsAt: number): number {
    const reset = new Date(resetsAt);
    const day = reset.getDate();
    const previous = new Date(reset.getTime());
    previous.setDate(1);
    previous.setMonth(previous.getMonth() - 1);
    const daysInPreviousMonth = new Date(previous.getFullYear(), previous.getMonth() + 1, 0).getDate();
    previous.setDate(Math.min(day, daysInPreviousMonth));
    return previous.getTime();
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

// The figure under each day block (#2164): the share of that day's part of the window already used, in whole percent,
// 0 included. The total is spread over the days from the reset, one seventh each, so the figures tell how many days'
// worth has been used (67 % from a Tuesday reset is 4.69 days' worth: Tuesday to Friday 100, Saturday 69, the others 0).
// They are the blocks' fills, so the two can never disagree.
export function dayShares(percent: number, start = 0): number[] {
    return dayFills(percent, start).map((fill) => Math.round(fill * 100));
}

// The day figures as one sentence, for a row that draws no figure under its blocks (#2450): "Mon 100 %, Tue 100 %, Wed
// 69 %, Thu 0 %…", Monday first, the days in the interface language. They are the figures dayShares gives.
export function dayFiguresText(percent: number, start = 0): string {
    const locale = getLocale();
    return dayShares(percent, start)
        .map((share, i) =>
            t("usageWeek.dayFigure", {
                // 2024-01-01 was a Monday.
                day: new Date(2024, 0, 1 + i).toLocaleDateString(locale, { weekday: "short" }),
                share,
            })
        )
        .join(", ");
}

// How full each day block of a line is: a deduced week fills each day by its own use (an unknown day stays empty),
// any other week spreads its total from the reset day (dayFills).
export function lineDayFills(line: UsageWeekLine): number[] {
    if (line.days == null) {
        return dayFills(line.percent, line.start);
    }
    return line.days.map((d) => (d > 0 ? Math.min(1, d / 100) : 0));
}

// The figure under each day block of a line; null for a day a deduced week does not know.
export function lineDayShares(line: UsageWeekLine): number[] {
    if (line.days == null) {
        return dayShares(line.percent, line.start);
    }
    return line.days.map((d) => (d === DayUnknown ? null : Math.round(d)));
}

// The day figures of a line as one sentence (dayFiguresText); an unknown day says so.
export function lineDayFiguresText(line: UsageWeekLine): string {
    if (line.days == null) {
        return dayFiguresText(line.percent, line.start);
    }
    const locale = getLocale();
    return lineDayShares(line)
        .map((share, i) => {
            // 2024-01-01 was a Monday.
            const day = new Date(2024, 0, 1 + i).toLocaleDateString(locale, { weekday: "short" });
            return share == null ? t("usageWeek.dayUnknown", { day }) : t("usageWeek.dayFigure", { day, share });
        })
        .join(", ");
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

function windowAllowedPercent(window: UsageWindow, now: number): number {
    const resetsAt = window.resetsat ?? 0;
    if (window.id !== MonthWindowId) {
        return allowedPercent(resetsAt, windowLength(window), now);
    }
    if (!(resetsAt > 0)) {
        return -1;
    }
    const previous = previousMonthReset(resetsAt);
    return Math.min(1, Math.max(0, (now - previous) / (resetsAt - previous))) * 100;
}

// The line one window draws. A month uses calendar arithmetic in local time, never a fixed duration.
export function usageWeekLine(window: UsageWindow, now: number): UsageWeekLine {
    const used = Math.max(0, window.usedpercent);
    // A deduced week can pass its budget (#2451); a provider's own share stops at 100.
    const percent = Math.round(window.deduced ? used : Math.min(100, used));
    const resetsAt = window.resetsat ?? 0;
    const windowMins = windowLength(window);
    const allowed = windowAllowedPercent(window, now);
    const pace =
        allowed < 0 ? (percent > GravePercent ? PaceRedAt * 2 : 1) : percent / Math.max(MinAllowedPercent, allowed);
    const unused = allowed < 0 ? 0 : Math.max(0, allowed - percent);
    const start = !(resetsAt > 0)
        ? -1
        : weekdayIndex(window.id === MonthWindowId ? previousMonthReset(resetsAt) : lastReset(resetsAt, windowMins));
    return {
        percent,
        pace,
        unused,
        resetsAt,
        windowMins,
        start,
        used,
        days: window.deduced && Array.isArray(window.days) && window.days.length === 7 ? window.days : undefined,
    };
}

// The line of each running window of a list, in the reader's order: a window past its reset draws none.
export function usageWeekLines(windows: UsageWindow[], now: number): UsageWeekLine[] {
    return (windows ?? []).filter((w) => isRunning(w, now)).map((w) => usageWeekLine(w, now));
}
