// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The month read like a week (#2532, FR-SHELL-018, FR-BOSS-009 AC109 to AC112): its used share spread over its days from
// the reset, one calendar week at a time, the days late or ahead told in days, and the share no session can still use.
// Each case is a row of the validated mockup (https://claude.ai/artifact/LyVT1guodQk6xReNiSKnBw), on January 2024, whose
// first day was a Monday: a 31-day month resetting on Monday 1 January at 00:00.

import { describe, expect, it } from "vitest";
import type { UsageWindow } from "../companion/companion-gauges-model";
import { I18nModel } from "../i18n/i18n";
import {
    currentWeekIndex,
    DayCell,
    dayFill,
    dayFills,
    daysFigure,
    lineCells,
    lineDayFiguresText,
    lostPart,
    lostShare,
    paceNote,
    stepWeek,
    usageWeekLine,
    weekCaption,
    windowWeeks,
} from "./usage-week-model";

const Day = 24 * 60 * 60 * 1000;
const at = (month: number, day: number, hour = 0, minute = 0, year = 2024) =>
    new Date(year, month - 1, day, hour, minute).getTime();

// A 31-day month, resetting on the 1st of February at 00:00.
const FebruaryFirst = at(2, 1);
// What half a day of a 31-day month is.
const HalfADay = (0.5 / 31) * 100;

function month(used: number, extra: Partial<UsageWindow> = {}, resetsat = FebruaryFirst): UsageWindow {
    return { id: "month", label: "This month", usedpercent: used, resetsat, ...extra };
}

const session: UsageWindow = { id: "session", label: "Current session", usedpercent: 15, windowmins: 300 };

const fills = (cells: DayCell[]) => cells.map((c) => Math.round(c.fill * 100));
const shares = (cells: DayCell[]) => cells.map((c) => c.share);

describe("the month spread over its days, from the reset (mockup rows 2, 3 and 4)", () => {
    it("is the rule of dayFills for a window of any length: whole days full, the next partly, the rest empty", () => {
        expect(dayFill(2.5, 0)).toBe(1);
        expect(dayFill(2.5, 2)).toBe(0.5);
        expect(dayFill(2.5, 3)).toBe(0);
        // A week is the same rule with seven days, from its reset day.
        expect([0, 1, 2, 3, 4, 5, 6].map((k) => Math.round(dayFill((50 * 7) / 100, k) * 100) / 100)).toEqual(
            dayFills(50, 0).map((f) => Math.round(f * 100) / 100)
        );
    });

    it("gives each day 1/31 of the month: half a day used on the 1st reads 50 % on that day and 0 % on every other (row 3)", () => {
        const now = at(1, 10, 12);
        const line = usageWeekLine(month(HalfADay), now, [session]);
        expect(line.span).toMatchObject({ days: 31, monthly: true });
        const first = lineCells(line, now, 0);
        expect(shares(first)).toEqual([50, 0, 0, 0, 0, 0, 0]);
        expect(first[0].reset).toBe(true);
        expect(first.some((c) => c.today || c.out)).toBe(false);
    });

    it("keeps a day not worked owed: the fill never jumps to today (row 2)", () => {
        // Wednesday 10 January, 12:00: nine and a half days since the reset, half a day used on the 1st.
        const now = at(1, 10, 12);
        const line = usageWeekLine(month(HalfADay), now, [session]);
        const weeks = windowWeeks(line.span);
        expect(weeks.count).toBe(5);
        // It opens on the week holding today: the second, 8 to 14 January, all empty, today lit on the Wednesday.
        expect(currentWeekIndex(weeks, now)).toBe(1);
        const current = lineCells(line, now);
        expect(fills(current)).toEqual([0, 0, 0, 0, 0, 0, 0]);
        expect(current.map((c) => c.today)).toEqual([false, false, true, false, false, false, false]);
        // The week of the 1st is the only one that holds the use.
        expect(fills(lineCells(line, now, 0))).toEqual([50, 0, 0, 0, 0, 0, 0]);
    });

    it("fills the days a catch-up reaches, whole days first and today's day partly (row 4)", () => {
        // 30 % of 31 days is 9.3 days: the week of the 1st, the 8th and the 9th full, the 10th at 30 %.
        const now = at(1, 10, 12);
        const line = usageWeekLine(month(30), now, [session]);
        expect(fills(lineCells(line, now, 0))).toEqual([100, 100, 100, 100, 100, 100, 100]);
        expect(fills(lineCells(line, now, 1))).toEqual([100, 100, 30, 0, 0, 0, 0]);
        expect(shares(lineCells(line, now, 1))).toEqual([100, 100, 30, 0, 0, 0, 0]);
        expect(fills(lineCells(line, now, 2))).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });

    it("spreads the unrounded share, so a small month is not rounded into whole days", () => {
        const now = at(1, 10, 12);
        // 1.6129 % reads "2 %" as a percent text, and half a day, not 0.62, in its blocks.
        const line = usageWeekLine(month(HalfADay), now, [session]);
        expect(line.percent).toBe(2);
        expect(lineCells(line, now, 0)[0].fill).toBeCloseTo(0.5, 6);
    });

    it("counts the days of the window from the reset date to the next reset's date, a 30-day month included", () => {
        const now = at(11, 20, 12, 0, 2026);
        const november = usageWeekLine(month(10, {}, at(12, 1, 1, 0, 2026)), now, [session]);
        expect(november.span.days).toBe(30);
        // Reset on 29 February 2024, the month before it being 31 days of January to 29 February.
        const leap = usageWeekLine(month(10, {}, at(3, 1, 0, 0, 2024)), at(2, 10, 12), [session]);
        expect(leap.span.days).toBe(29);
    });
});

describe("one calendar week at a time (mockup rows 2, 3, 5 and 6)", () => {
    it("lists the weeks that touch the window, Monday to Sunday: five for January 2024", () => {
        const line = usageWeekLine(month(0), at(1, 10, 12), [session]);
        const weeks = windowWeeks(line.span);
        expect(weeks.count).toBe(5);
        expect(weeks.first).toBe(at(1, 1));
    });

    it("tells which week and which days, in the interface language", () => {
        const line = usageWeekLine(month(0), at(1, 10, 12), [session]);
        const weeks = windowWeeks(line.span);
        const second = weekCaption(weeks, 1);
        expect(second.count).toBe("Week 2 of 5");
        expect(second.short).toBe("Wk 2/5");
        expect(second.range).toMatch(/8.*14/);
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            const fr = weekCaption(weeks, 1);
            expect(fr.count).toBe("Semaine 2 sur 5");
            expect(fr.short).toBe("Sem. 2/5");
            expect(fr.range).toMatch(/8.*14.*janv/);
        } finally {
            i18n.setLanguageSetting("");
        }
    });

    it("moves a week with each control and stops at the first and the last week of the window", () => {
        expect(stepWeek(1, 5, "next")).toBe(2);
        expect(stepWeek(1, 5, "prev")).toBe(0);
        expect(stepWeek(0, 5, "prev")).toBe(0);
        expect(stepWeek(4, 5, "next")).toBe(4);
        // Moving through every week of the window and back leaves nothing out.
        const visited = [0];
        for (let i = 0; i < 4; i++) {
            visited.push(stepWeek(visited[visited.length - 1], 5, "next"));
        }
        expect(visited).toEqual([0, 1, 2, 3, 4]);
    });

    it("opens on the week holding today, the first or the last when today is outside the window", () => {
        const line = usageWeekLine(month(0), at(1, 10, 12), [session]);
        const weeks = windowWeeks(line.span);
        expect(currentWeekIndex(weeks, at(1, 10, 12))).toBe(1);
        expect(currentWeekIndex(weeks, at(1, 29, 9))).toBe(4);
        expect(currentWeekIndex(weeks, at(1, 1, 0))).toBe(0);
        expect(currentWeekIndex(weeks, at(12, 20, 9, 0, 2023))).toBe(0);
        expect(currentWeekIndex(weeks, at(2, 20, 9))).toBe(4);
    });

    it("greys the days outside the window, with no figure: before the reset date, and from the next reset's date on (rows 5 and 6)", () => {
        // A reset on Wednesday 17 January: Monday and Tuesday of that week are before the window.
        const reset = at(2, 17);
        const now = at(1, 19, 12);
        const line = usageWeekLine(month(12, {}, reset), now, [session]);
        const first = lineCells(line, now, 0);
        expect(first.map((c) => c.out)).toEqual([true, true, false, false, false, false, false]);
        expect(shares(first)).toEqual([null, null, 100, 100, 100, 72, 0]);
        expect(fills(first)).toEqual([0, 0, 100, 100, 100, 72, 0]);
        expect(first.map((c) => c.reset)).toEqual([false, false, true, false, false, false, false]);
        // Fills: 12 % of 31 days is 3.72 days, Wednesday to Friday full, Saturday 72 %.
        const last = lineCells(line, now, windowWeeks(line.span).count - 1);
        // The last week holds 12 and 13 February... the next reset (17 February) and the days after it are out.
        expect(last.filter((c) => c.out).length).toBeGreaterThan(0);
        expect(last.every((c) => c.out || (c.share ?? -1) >= 0)).toBe(true);
    });

    it("leaves the day of the next reset outside the window: the last week of January ends on the 31st (row 5)", () => {
        const now = at(1, 25, 12);
        const line = usageWeekLine(month(40), now, [session]);
        const last = lineCells(line, now, 4);
        // Monday 29, Tuesday 30, Wednesday 31 January; Thursday 1 February is the next reset's date.
        expect(last.map((c) => c.out)).toEqual([false, false, false, true, true, true, true]);
        expect(shares(last)).toEqual([0, 0, 0, null, null, null, null]);
    });

    it("marks today only in the week that holds it, and the reset ring only on the reset day", () => {
        const now = at(1, 10, 12);
        const line = usageWeekLine(month(30), now, [session]);
        const todays = [0, 1, 2, 3, 4].map((week) => lineCells(line, now, week).filter((c) => c.today).length);
        expect(todays).toEqual([0, 1, 0, 0, 0]);
        const resets = [0, 1, 2, 3, 4].map((week) => lineCells(line, now, week).filter((c) => c.reset).length);
        expect(resets).toEqual([1, 0, 0, 0, 0]);
    });

    it("says the figures of the week it shows, a day outside the window left out", () => {
        const now = at(1, 19, 12);
        const line = usageWeekLine(month(12, {}, at(2, 17)), now, [session]);
        expect(lineDayFiguresText(line, now, 0)).toBe("Wed 100 %, Thu 100 %, Fri 100 %, Sat 72 %, Sun 0 %");
    });
});

describe("days late or ahead (mockup rows 2, 4, 5, 6 and 7)", () => {
    it("counts the days elapsed since the reset, less the days consumed: 9 d late with half a day used by the 10th, noon (row 2)", () => {
        const line = usageWeekLine(month(HalfADay), at(1, 10, 12), [session]);
        expect(line.span.late).toBeCloseTo(9, 6);
        expect(paceNote(line)).toEqual({ pace: "9 d late", lost: "" });
    });

    it("reads on time within half a day of its pace (row 4)", () => {
        const line = usageWeekLine(month(30), at(1, 10, 12), [session]);
        expect(line.span.late).toBeCloseTo(0.2, 6);
        expect(paceNote(line).pace).toBe("on time");
    });

    it("tells days ahead, with a decimal under three days (row 6)", () => {
        const line = usageWeekLine(month(12, {}, at(2, 17)), at(1, 19, 12), [session]);
        expect(line.span.late).toBeCloseTo(-1.22, 2);
        expect(paceNote(line).pace).toBe("1.2 d ahead");
    });

    it("tells a weekly window's days the same way (row 7): a Tuesday reset, half of Tuesday used, on Thursday", () => {
        // Reset on Tuesday 2 January 00:00 of a 7-day window: 2 days in on Thursday 4 January, 50 % of a day used.
        const week: UsageWindow = {
            id: "week",
            label: "This week",
            usedpercent: (0.5 / 7) * 100,
            resetsat: at(1, 9),
            windowmins: 10080,
        };
        const line = usageWeekLine(week, at(1, 4, 0, 30), [session]);
        expect(line.span).toMatchObject({ days: 7, monthly: false });
        expect(line.span.late).toBeCloseTo(1.52, 2);
        expect(paceNote(line).pace).toBe("1.5 d late");
        // The weekly row is drawn as it always was, from its rounded percent: the fill starts on the reset day and wraps
        // round the week (7 % of the week is 0.49 of a day).
        expect(fills(lineCells(line, at(1, 4, 0, 30)))).toEqual([0, 49, 0, 0, 0, 0, 0]);
    });

    it("writes figures in the language of the interface: 1,5 j de retard, 1,2 j d'avance, à l'heure", () => {
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            const late = usageWeekLine(
                { id: "week", label: "This week", usedpercent: 7.14, resetsat: at(1, 9), windowmins: 10080 },
                at(1, 4, 0, 30)
            );
            expect(paceNote(late).pace).toBe("1,5 j de retard");
            const ahead = usageWeekLine(month(12, {}, at(2, 17)), at(1, 19, 12));
            expect(paceNote(ahead).pace).toBe("1,2 j d'avance");
            expect(paceNote(usageWeekLine(month(30), at(1, 10, 12))).pace).toBe("à l'heure");
        } finally {
            i18n.setLanguageSetting("");
        }
    });

    it("shows whole days from three days on", () => {
        expect(daysFigure(1.24)).toBe("1.2");
        expect(daysFigure(2.96)).toBe("3");
        expect(daysFigure(8.01)).toBe("8");
        expect(daysFigure(12.4)).toBe("12");
        expect(daysFigure(-9)).toBe("9");
    });

    it("tells nothing of a window whose reset time is not known", () => {
        const line = usageWeekLine(
            { id: "week", label: "This week", usedpercent: 40, windowmins: 10080 },
            at(1, 10, 12)
        );
        expect(line.span).toBeUndefined();
        expect(paceNote(line)).toBeNull();
    });
});

describe("the share lost, only with a session window and a measured worth (mockup row 5)", () => {
    // Thursday 25 January, noon: 40 % of the month used, 6.5 days to the reset, a full session worth 1.5 % of it.
    const now = at(1, 25, 12);
    const measured = month(40, { sessionworth: 1.5, sessionmins: 300 });

    it("is what the pool has left beyond the session windows left times a full session's worth", () => {
        // 156 h left is 31.2 sessions of 5 h, worth 46.8 %: of the 60 % left, 13.2 % cannot be used.
        const lost = lostShare(40, FebruaryFirst, now, 300, 1.5, 31);
        expect(lost.percent).toBeCloseTo(13.2, 6);
        // Told in days of the window: 13.2 % of 31 days.
        expect(lost.days).toBeCloseTo(4.09, 2);
    });

    it("is hatched at the end of the window: the days after 31 - 4.09, the last ones fully (row 5)", () => {
        expect(lostPart(30, 31, 4.09)).toBe(1);
        expect(lostPart(27, 31, 4.09)).toBe(1);
        expect(lostPart(26, 31, 4.09)).toBeCloseTo(0.09, 6);
        expect(lostPart(25, 31, 4.09)).toBe(0);
        expect(lostPart(30, 31, 0)).toBe(0);
        const line = usageWeekLine(measured, now, [session]);
        const last = lineCells(line, now, 4);
        expect(last.slice(0, 3).map((c) => c.lost)).toEqual([1, 1, 1]);
        expect(last.slice(3).every((c) => c.out && c.lost === 0)).toBe(true);
        const fourth = lineCells(line, now, 3);
        // 22 to 28 January: the 27th loses the last 9 % of its day, the 28th all of it.
        expect(fourth.map((c) => Math.round(c.lost * 100) / 100)).toEqual([0, 0, 0, 0, 0, 0.09, 1]);
    });

    it("leaves the lost days out of the days late: 8 instead of 12, so no one chases what is gone", () => {
        const line = usageWeekLine(measured, now, [session]);
        // 24.5 days elapsed, 12.4 consumed: 12.1 behind; 4.09 of them can never be caught up.
        expect(line.span.late).toBeCloseTo(12.1 - 4.09, 2);
        expect(paceNote(line)).toEqual({ pace: "8 d late", lost: "13 % lost (4 d)" });
        const unmeasured = usageWeekLine(month(40), now, [session]);
        expect(paceNote(unmeasured)).toEqual({ pace: "12 d late", lost: "" });
    });

    it("never shows a lost share until a worth is measured, and never hatches a day", () => {
        const line = usageWeekLine(month(40), now, [session]);
        expect(line.span.lost).toBeUndefined();
        for (let week = 0; week < 5; week++) {
            expect(lineCells(line, now, week).every((c) => c.lost === 0)).toBe(true);
        }
    });

    it("is none for a plan without a session window, however far behind and whatever worth is held", () => {
        // No session in the reading, and none known to the history: a plan without sessions catches up any day.
        const noSession = usageWeekLine(month(40, { sessionworth: 1.5 }), now, []);
        expect(noSession.span.lost).toBeUndefined();
        expect(paceNote(noSession).lost).toBe("");
        expect(usageWeekLine(month(40, { sessionworth: 1.5 }), now).span.lost).toBeUndefined();
        expect(lostShare(40, FebruaryFirst, now, 0, 1.5, 31)).toBeUndefined();
    });

    it("holds when the reading carries no session window: the plan has one, as the worth was measured on it", () => {
        const line = usageWeekLine(measured, now, []);
        expect(line.span.lost.percent).toBeCloseTo(13.2, 6);
    });

    it("is none when the sessions left can use everything, when nothing is left of the window and under 1 %", () => {
        expect(lostShare(40, FebruaryFirst, now, 300, 3, 31)).toBeUndefined();
        expect(lostShare(40, now - Day, now, 300, 1.5, 31)).toBeUndefined();
        // 60 % left, 59.7 % usable: 0.3 % is not told.
        expect(lostShare(40, FebruaryFirst, now, 300, 59.7 / 31.2, 31)).toBeUndefined();
        expect(lostShare(40, FebruaryFirst, now, 300, 0, 31)).toBeUndefined();
    });

    it("applies to a weekly window with a session as well (Claude Code's week)", () => {
        // Tuesday reset: 7 days, 100 h left of the 168, a session worth 4 % of the week: 20 sessions, 80 % usable.
        const week: UsageWindow = {
            id: "week",
            label: "This week",
            usedpercent: 10,
            resetsat: now + 100 * 60 * 60 * 1000,
            windowmins: 10080,
            sessionworth: 4,
            sessionmins: 300,
        };
        const line = usageWeekLine(week, now, [session]);
        expect(line.span.lost.percent).toBeCloseTo(10, 6);
        expect(line.span.lost.days).toBeCloseTo(0.7, 6);
        expect(paceNote(line).lost).toBe("10 % lost (0.7 d)");
        // Its days are hatched at the end of its seven, from the reset day round the week.
        const cells = lineCells(line, now);
        const k = (i: number) => (i - line.start + 7) % 7;
        const lastDay = cells.findIndex((_, i) => k(i) === 6);
        expect(cells[lastDay].lost).toBeCloseTo(0.7, 6);
    });

    it("says in words the lost day in the figures of its blocks", () => {
        const line = usageWeekLine(measured, now, [session]);
        expect(lineDayFiguresText(line, now, 4)).toBe("Mon lost, Tue lost, Wed lost");
    });
});
