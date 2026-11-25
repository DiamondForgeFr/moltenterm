// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The week grid of a plan usage (FR-BOSS-009, AC48 to AC51, #2100): from the windows a reader gives (FR-SHELL-027), the
// line each one draws under the initials of the calendar week, Monday to Sunday: its rounded percent, the block of its
// last reset (0 %, where the fill starts and runs forward round the week) and its pace (consumed against the share of
// the window elapsed since that reset). Pure and tied to no surface: Brokk's group shows it, and so do the companion's
// gauges (#2102).
//
// A window is a pool (the window of the global reset, weekly or monthly) and a plan may also have a session (the short
// window, 5 h). A monthly pool spreads its used share over its days from the reset, each worth 1/D of it, and shows one
// calendar week at a time (#2532). A weekly or monthly row tells how many days late or ahead it is and, for a plan
// with a session window whose worth is measured, the share that can no longer be used before the reset.

import type { UsageWindow } from "../companion/companion-gauges-model";
import { getLocale, t } from "../i18n/i18n";

export const WeekWindowId = "week";
export const MonthWindowId = "month";
// A window known only by its length: seven days.
const WeekMins = 7 * 24 * 60;
export const SessionWindowId = "session";
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
const DayMs = MinsPerDay * 60 * 1000;

// A row reads "on time" within this many days of its pace, and a lost share under this many percent is not told.
export const OnTimeDays = 0.5;
export const MinLostPercent = 1;
// Below this many days a figure shows its decimal ("1.2 d"); from it, whole days.
const WholeDaysFrom = 3;

// The keys of the week's initials (usageWeek.day.*), Monday first in every language.
export const WeekDayKeys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// What a pool window says in days (#2532). Absent while its reset time is not known.
export type WindowSpan = {
    // The reset date that opened the window, at local midnight (Unix ms): its first day.
    startDay: number;
    // The calendar days of the window, from that date to the next reset's date (31 for a 31-day month, 7 for a week):
    // each is worth 1/days of the window.
    days: number;
    // A calendar month is shown one calendar week at a time; a week is shown as it always was.
    monthly: boolean;
    // How far behind (positive) or ahead of (negative) its pace the window is, in days: the days elapsed since the
    // reset less the days consumed. What cannot be used any more (`lost`) is left out of it.
    late: number;
    // The share of the pool no session can still use before the reset; absent without a measured worth.
    lost?: LostShare;
};

export type LostShare = { percent: number; days: number };

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
    // A window that is neither weekly nor monthly (a five-hour session, a 30-day window) draws one plain gauge, not the
    // seven days (#2451, #2532). The companion sets it (isWeekWindow); Brokk's group draws every provider's main window
    // on the week.
    plain?: boolean;
    // The window's days, its days late or ahead and the share lost (#2532).
    span?: WindowSpan;
};

// The narrowest day block a figure fits under without touching its neighbour's: three tabular digits at 11 px ("130")
// and a little air (#2451, #2458). usage-week.css hides the figure of a block narrower than this (@container
// max-width, MinFigureBlockPx less 0.02), by the width of that block, whatever the label column and the percent take.
export const MinFigureBlockPx = 22;
// The block width from which a figure also shows its "%" unit (usage-week.css, @container min-width).
export const MinUnitBlockPx = 32;

// The windows the seven days tell something of: a week (Claude's per-model weeks included) and a calendar month, which
// shows one week of its days at a time (#2532). Any other window is a plain gauge (#2451).
export function isWeekWindow(window: UsageWindow): boolean {
    return (
        window.id === WeekWindowId ||
        window.id === MonthWindowId ||
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

// The fill of the day k days after the reset, when `units` days' worth has been used: whole days full from the reset
// forward, the next one partly, the rest empty. It is the rule of dayFills for a window of any length (#2532).
export function dayFill(units: number, k: number): number {
    return Math.min(1, Math.max(0, units - k));
}

// ---- the days of a window, one calendar week at a time (#2532) ----

// Local midnight of the day holding `at`.
export function dayStart(at: number): number {
    const d = new Date(at);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

// The day `n` calendar days after the one starting at `day`, at local midnight: a change of daylight saving time never
// shifts it.
export function addDays(day: number, n: number): number {
    const d = new Date(day);
    d.setDate(d.getDate() + n);
    return d.getTime();
}

// The whole calendar days from one local midnight to another.
export function dayDiff(from: number, to: number): number {
    return Math.round((to - from) / DayMs);
}

function mondayOf(day: number): number {
    return addDays(day, -weekdayIndex(day));
}

// The calendar weeks, Monday to Sunday, that hold a day of the window: the first one's Monday and how many there are.
export type WindowWeeks = { first: number; count: number };

export function windowWeeks(span: WindowSpan): WindowWeeks {
    const first = mondayOf(span.startDay);
    const lastDay = addDays(span.startDay, Math.max(1, span.days) - 1);
    return { first, count: Math.floor(dayDiff(first, lastDay) / DaysInWeek) + 1 };
}

// The week holding today, the first or the last when today is outside the window.
export function currentWeekIndex(weeks: WindowWeeks, now: number): number {
    const index = Math.floor(dayDiff(weeks.first, dayStart(now)) / DaysInWeek);
    return Math.min(weeks.count - 1, Math.max(0, index));
}

// The TypeScript library this project builds with predates formatRange, which Electron's engine has.
type RangeFormat = Intl.DateTimeFormat & { formatRange(from: Date, to: Date): string };

// The week a control moves to: the next or the previous one, never past the first or the last of the window.
export function stepWeek(index: number, count: number, dir: "prev" | "next"): number {
    return Math.min(count - 1, Math.max(0, index + (dir === "next" ? 1 : -1)));
}

// "Week 2 of 5" and "8–14 Jan": the two lines under a monthly row's label. The range is the calendar week's, Monday to
// Sunday, in the interface language.
export function weekCaption(weeks: WindowWeeks, index: number): { count: string; range: string } {
    const monday = addDays(weeks.first, index * DaysInWeek);
    const sunday = addDays(monday, DaysInWeek - 1);
    const format = new Intl.DateTimeFormat(getLocale(), { day: "numeric", month: "short" }) as RangeFormat;
    return {
        count: t("usageWeek.weekOf", { week: index + 1, weeks: weeks.count }),
        range: format.formatRange(new Date(monday), new Date(sunday)),
    };
}

// One day block of a row.
export type DayCell = {
    // How full it is, 0 to 1.
    fill: number;
    // The figure under it, in whole percent; null for a day outside the window.
    share: number | null;
    // A day before the window's reset date, or from the next reset's date on.
    out: boolean;
    // How much of the end of the day is lost (0 to 1): hatched, and left out of the days late.
    lost: number;
    // The window's first day: the reset's ring.
    reset: boolean;
    today: boolean;
};

// The lost days sit at the end of the window: the day k (0 for the reset day) loses what of it lies past D - lostDays.
export function lostPart(k: number, windowDays: number, lostDays: number): number {
    if (!(lostDays > 0)) {
        return 0;
    }
    return Math.min(1, Math.max(0, k + 1 - (windowDays - lostDays)));
}

// The seven day blocks of a line, Monday to Sunday. A monthly window shows the calendar week `weekIndex` of its days (the
// one holding today when not given), each day worth 1/D of it from the reset date; any other week is drawn as it
// always was, from its reset day round the week. The lost days, when the line has some, are hatched at the end of the
// window.
export function lineCells(line: UsageWeekLine, now: number, weekIndex?: number): DayCell[] {
    const span = line.span;
    const today = dayStart(now);
    const lostDays = span?.lost?.days ?? 0;
    if (span?.monthly) {
        const weeks = windowWeeks(span);
        const index = Math.min(weeks.count - 1, Math.max(0, weekIndex ?? currentWeekIndex(weeks, now)));
        const monday = addDays(weeks.first, index * DaysInWeek);
        const units = (Math.min(100, Math.max(0, line.used ?? line.percent)) * span.days) / 100;
        return Array.from({ length: DaysInWeek }, (_, i) => {
            const day = addDays(monday, i);
            const k = dayDiff(span.startDay, day);
            const out = k < 0 || k >= span.days;
            const fill = out ? 0 : dayFill(units, k);
            return {
                fill,
                share: out ? null : Math.round(fill * 100),
                out,
                lost: out ? 0 : lostPart(k, span.days, lostDays),
                reset: k === 0,
                today: day === today,
            };
        });
    }
    const fills = dayFills(line.percent, line.start);
    const todayIndex = weekdayIndex(now);
    return fills.map((fill, i) => ({
        fill,
        share: Math.round(fill * 100),
        out: false,
        lost:
            span != null && line.start >= 0
                ? lostPart((i - line.start + DaysInWeek) % DaysInWeek, span.days, lostDays)
                : 0,
        reset: i === line.start,
        today: i === todayIndex,
    }));
}

// The figure under each day block of a line; null for a day outside the window.
export function lineDayShares(line: UsageWeekLine, now: number, weekIndex?: number): (number | null)[] {
    return lineCells(line, now, weekIndex).map((c) => c.share);
}

// The day figures of a line as one sentence (dayFiguresText), for the row's name and tooltip: a day outside the window is
// left out, a day lost says so.
export function lineDayFiguresText(line: UsageWeekLine, now: number, weekIndex?: number): string {
    const locale = getLocale();
    return lineCells(line, now, weekIndex)
        .map((cell, i) => {
            if (cell.out) {
                return "";
            }
            // 2024-01-01 was a Monday.
            const day = new Date(2024, 0, 1 + i).toLocaleDateString(locale, { weekday: "short" });
            return cell.lost >= 1
                ? t("usageWeek.dayLost", { day })
                : t("usageWeek.dayFigure", { day, share: cell.share });
        })
        .filter((s) => s !== "")
        .join(", ");
}

// ---- the days late or ahead, and the share lost (#2532) ----

// A figure of days: one decimal under ten days, whole days from there, in the interface language ("1.2", "1,2", "12").
export function daysFigure(days: number): string {
    const value = Math.abs(days);
    const digits = value < WholeDaysFrom ? 1 : 0;
    return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: digits }).format(value);
}

// What no session can still use before the pool resets: the session windows left (the time left over the session's
// length) times what a full session is worth in percent of the pool; what the pool has left beyond that is lost, in
// percent of the pool and in days of the window. Undefined without a measured worth, without a session length, with
// nothing left of the window, and under MinLostPercent of the pool: nothing is ever guessed.
export function lostShare(
    used: number,
    resetsAt: number,
    now: number,
    sessionMins: number,
    worth: number,
    windowDays: number
): LostShare | undefined {
    if (!(worth > 0) || !(sessionMins > 0) || !(resetsAt > now) || !(windowDays > 0)) {
        return undefined;
    }
    const sessionsLeft = (resetsAt - now) / (sessionMins * 60 * 1000);
    const left = Math.max(0, 100 - Math.max(0, used));
    const percent = left - sessionsLeft * worth;
    if (Math.round(percent) < MinLostPercent) {
        return undefined;
    }
    return { percent, days: (percent * windowDays) / 100 };
}

// How the days late or ahead of a row read, the lost share beside them: "8 d late", "1.2 d ahead", "on time", and
// "13 % lost (4 d)". Empty without a window to tell them of.
export type PaceNote = { pace: string; lost: string };

export function paceNote(line: UsageWeekLine): PaceNote | null {
    const span = line.span;
    if (span == null) {
        return null;
    }
    let pace = t("usageWeek.onTime");
    if (span.late >= OnTimeDays) {
        pace = t("usageWeek.late", { days: daysFigure(span.late) });
    } else if (span.late <= -OnTimeDays) {
        pace = t("usageWeek.ahead", { days: daysFigure(span.late) });
    }
    const lost = span.lost
        ? t("usageWeek.lost", { percent: Math.round(span.lost.percent), days: daysFigure(span.lost.days) })
        : "";
    return { pace, lost };
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

// The window's last reset (Unix ms): a month uses calendar arithmetic in local time, never a fixed duration.
function windowLastReset(window: UsageWindow): number {
    const resetsAt = window.resetsat ?? 0;
    return window.id === MonthWindowId ? previousMonthReset(resetsAt) : lastReset(resetsAt, windowLength(window));
}

// The days of a window that is a week or a month, with its days late or ahead and its share lost; undefined without a
// reset time. The session limits the use: its length is the one the worth was measured on (sessionmins), else the length
// of the session among `windows`, the windows of the reading. The worth itself is the reader's history's, on the pool's
// own window (sessionworth).
function windowSpan(window: UsageWindow, now: number, used: number, windows: UsageWindow[]): WindowSpan | undefined {
    const resetsAt = window.resetsat ?? 0;
    if (!(resetsAt > 0) || !isWeekWindow(window)) {
        return undefined;
    }
    const lastResetAt = windowLastReset(window);
    const startDay = dayStart(lastResetAt);
    const monthly = window.id === MonthWindowId;
    const days = monthly ? Math.max(1, dayDiff(startDay, dayStart(resetsAt))) : DaysInWeek;
    const elapsed = Math.min(days, Math.max(0, (now - lastResetAt) / DayMs));
    const consumed = (Math.min(100, used) * days) / 100;
    const session = (windows ?? []).find((w) => w.id === SessionWindowId);
    const sessionMins = window.sessionmins > 0 ? window.sessionmins : session ? windowLength(session) : 0;
    const lost = lostShare(used, resetsAt, now, sessionMins, window.sessionworth ?? 0, days);
    // The lost days can never be caught up: the days late only counts what still can.
    const behind = elapsed - consumed;
    const late = lost && behind > 0 ? Math.max(0, behind - lost.days) : behind;
    return { startDay, days, monthly, late, lost };
}

// The line one window draws. `windows` are all the windows of its reading, for the session that limits it (#2532).
export function usageWeekLine(window: UsageWindow, now: number, windows?: UsageWindow[]): UsageWeekLine {
    const used = Math.max(0, window.usedpercent);
    // A provider's own share stops at 100.
    const percent = Math.round(Math.min(100, used));
    const resetsAt = window.resetsat ?? 0;
    const windowMins = windowLength(window);
    const allowed = windowAllowedPercent(window, now);
    const pace =
        allowed < 0 ? (percent > GravePercent ? PaceRedAt * 2 : 1) : percent / Math.max(MinAllowedPercent, allowed);
    const unused = allowed < 0 ? 0 : Math.max(0, allowed - percent);
    const start = !(resetsAt > 0) ? -1 : weekdayIndex(windowLastReset(window));
    return {
        percent,
        pace,
        unused,
        resetsAt,
        windowMins,
        start,
        used,
        span: windowSpan(window, now, used, windows),
    };
}

// The line of each running window of a list, in the reader's order: a window past its reset draws none.
export function usageWeekLines(windows: UsageWindow[], now: number): UsageWeekLine[] {
    return (windows ?? []).filter((w) => isRunning(w, now)).map((w) => usageWeekLine(w, now, windows));
}
