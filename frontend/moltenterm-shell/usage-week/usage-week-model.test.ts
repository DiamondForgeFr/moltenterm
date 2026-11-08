// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import En from "../i18n/locales/en.json";
import Fr from "../i18n/locales/fr.json";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    allowedPercent,
    dayFills,
    lastReset,
    mainWindow,
    paceColour,
    PaceOrangeAt,
    paceRatio,
    PaceRedAt,
    startIndex,
    UnusedBlueAt,
    UnusedBlueFrom,
    unusedPoints,
    usageWeekLine,
    usageWeekLines,
    weekdayIndex,
    WeekDayKeys,
    windowLength,
} from "./usage-week-model";

const Now = new Date(2026, 10, 6, 10, 0, 0).getTime();
const Day = 24 * 60 * 60 * 1000;

describe("the week grid of a plan usage (FR-BOSS-009, AC48 to AC51, #2100)", () => {
    const round = (fills: number[]) => fills.map((f) => Math.round(f * 100) / 100);

    it("splits the fill as percent × 7 / 100 blocks, the last one partly, from Monday without a reset day", () => {
        expect(dayFills(0)).toEqual([0, 0, 0, 0, 0, 0, 0]);
        expect(dayFills(100)).toEqual([1, 1, 1, 1, 1, 1, 1]);
        expect(round(dayFills(50))).toEqual([1, 1, 1, 0.5, 0, 0, 0]);
        expect(round(dayFills(73, -1))).toEqual([1, 1, 1, 1, 1, 0.11, 0]);
        expect(dayFills(140)).toEqual(dayFills(100));
    });

    // The reset day's block is 0 %: the fill starts on it and runs forward, past Sunday to Monday.
    it.each([
        ["Monday", 0, 50, [1, 1, 1, 0.5, 0, 0, 0]],
        ["Tuesday", 1, 73, [0, 1, 1, 1, 1, 1, 0.11]],
        ["Tuesday", 1, 90, [0.3, 1, 1, 1, 1, 1, 1]],
        ["Thursday", 3, 50, [0, 0, 0, 1, 1, 1, 0.5]],
        ["Friday", 4, 66, [1, 0.62, 0, 0, 1, 1, 1]],
        ["Saturday", 5, 100, [1, 1, 1, 1, 1, 1, 1]],
        ["Sunday", 6, 31, [1, 0.17, 0, 0, 0, 0, 1]],
        ["Sunday", 6, 0, [0, 0, 0, 0, 0, 0, 0]],
    ])("starts the fill on a %s reset (block %i) for %i %%, wrapping round the week", (_, start, percent, fills) => {
        expect(round(dayFills(percent as number, start as number))).toEqual(fills);
    });

    it("writes the initials Monday first, in English and in French", () => {
        const initials = (dict: any) => WeekDayKeys.map((key) => dict.usageWeek.day[key]).join("");
        expect(initials(En)).toBe("MTWTFSS");
        expect(initials(Fr)).toBe("LMMJVSD");
    });

    it("counts the week from Monday, in local time", () => {
        // Friday 6 November 2026; Sunday 8; Monday 9.
        expect(weekdayIndex(Now)).toBe(4);
        expect(weekdayIndex(new Date(2026, 10, 8, 23, 0).getTime())).toBe(6);
        expect(weekdayIndex(new Date(2026, 10, 9, 0, 30).getTime())).toBe(0);
    });

    // Weekly windows resetting on different weekdays (mockup version 10): the start is their reset weekday.
    it.each([
        ["Friday", new Date(2026, 10, 13, 9, 0), 4],
        ["Monday", new Date(2026, 10, 16, 1, 0), 0],
        ["Sunday", new Date(2026, 10, 15, 18, 0), 6],
        ["Thursday", new Date(2026, 10, 19, 8, 0), 3],
        ["Saturday", new Date(2026, 10, 14, 7, 0), 5],
        ["Tuesday", new Date(2026, 10, 17, 9, 0), 1],
    ])("starts a week resetting on %s on that weekday", (_, resetsAt, index) => {
        expect(startIndex((resetsAt as Date).getTime(), 10080)).toBe(index);
    });

    it("starts a 30-day window on the weekday of its last reset, and nowhere without a reset time", () => {
        // Resets on Saturday 5 December 2026: it last reset on Thursday 5 November.
        expect(startIndex(new Date(2026, 11, 5, 14, 0).getTime(), 43200)).toBe(3);
        // Without a length, the reset itself.
        expect(startIndex(new Date(2026, 11, 5, 14, 0).getTime(), 0)).toBe(5);
        expect(startIndex(0, 10080)).toBe(-1);
    });

    it("takes whole calendar days off across a daylight saving change", () => {
        // Europe and America change their clocks between 25 October and 8 November 2026: a week resetting on Monday
        // 2 November at 00:30 last reset on Monday 26 October at 00:30, whatever the shift.
        const reset = new Date(2026, 10, 2, 0, 30).getTime();
        expect(lastReset(reset, 10080)).toBe(new Date(2026, 9, 26, 0, 30).getTime());
        expect(startIndex(reset, 10080)).toBe(0);
    });

    it("colours the pace: green up to 1, green to orange up to 1.15, orange to red up to 1.6, then red", () => {
        expect(paceColour(0.4)).toBe("var(--color-success)");
        expect(paceColour(1)).toBe("var(--color-success)");
        expect(paceColour(1.075)).toBe("color-mix(in srgb, var(--color-warning) 50%, var(--color-success))");
        expect(paceColour(PaceOrangeAt)).toBe("color-mix(in srgb, var(--color-warning) 100%, var(--color-success))");
        expect(paceColour(1.375)).toBe("color-mix(in srgb, var(--color-error) 50%, var(--color-warning))");
        expect(paceColour(PaceRedAt + 0.01)).toBe("var(--color-error)");
    });

    it("keeps the ratio finite right after a reset", () => {
        const ratio = paceRatio(47, Now + 30 * Day, 43200, Now);
        expect(Number.isFinite(ratio)).toBe(true);
        expect(ratio).toBeGreaterThan(PaceRedAt);
    });
});

// #2106: the slim grid of mockup version 13, the same in Brokk's group and the companion.
describe("the slim week grid (FR-BOSS-009, AC56, #2106)", () => {
    const css = readFileSync(join(__dirname, "usage-week.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string) =>
        new RegExp(`\\n${selector.replace(/[.[\]]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";

    it("draws 6 px blocks, 3 px apart, at most 30 px wide, packed to the start", () => {
        const grid = rule(".mt-uw");
        expect(grid).toContain("--mt-uw-block-h: 6px;");
        expect(grid).toContain("--mt-uw-block-max: 30px;");
        expect(grid).toContain("repeat(7, minmax(var(--mt-uw-block-min), var(--mt-uw-block-max)))");
        expect(grid).toContain("justify-content: start;");
        expect(grid).toContain("gap: 7px 3px;");
        expect(rule(".mt-uw-cell")).toContain("height: var(--mt-uw-block-h);");
    });

    it("gives the percent a column wide enough for 100 % on one line", () => {
        expect(rule(".mt-uw")).toContain("minmax(52px, max-content);");
        expect(rule(".mt-uw-pct")).toContain("white-space: nowrap;");
    });

    it("rings the reset day thin and close, and outlines today with 1 px at low opacity", () => {
        expect(rule(".mt-uw-cell.is-reset")).toContain("outline: 1px solid var(--mt-action);");
        expect(rule(".mt-uw-cell.is-reset")).toContain("outline-offset: 1.5px;");
        expect(rule(".mt-uw-cell.is-today")).toContain(
            "box-shadow: 0 0 0 1px color-mix(in srgb, var(--mt-text-1) 35%, transparent);"
        );
    });
});

// #2106: too little used for the time gone, tokens risk being lost before the reset: green turns to blue.
describe("the under-use scale (FR-BOSS-009, AC59, #2106)", () => {
    // Thursday 12 November 2026, 10:00; a weekly window that resets on Tuesday last reset on Tuesday 10, 2 days ago.
    const thursday = new Date(2026, 10, 12, 10, 0).getTime();
    const tuesday = new Date(2026, 10, 17, 10, 0).getTime();

    it("counts the points the time gone allowed and the window did not use", () => {
        expect(allowedPercent(tuesday, 10080, thursday)).toBeCloseTo((2 / 7) * 100, 5);
        expect(unusedPoints(0, tuesday, 10080, thursday)).toBeCloseTo((2 / 7) * 100, 5);
        expect(unusedPoints(40, tuesday, 10080, thursday)).toBe(0);
        expect(unusedPoints(40, 0, 10080, thursday)).toBe(0);
        expect(unusedPoints(40, tuesday, 0, thursday)).toBe(0);
    });

    it("keeps the normal rule up to 10 points unused, mixes green to blue past them, full blue from 35", () => {
        expect(paceColour(0.7, UnusedBlueFrom)).toBe("var(--color-success)");
        expect(paceColour(1.3, 4)).toBe("color-mix(in srgb, var(--color-error) 33%, var(--color-warning))");
        expect(paceColour(0.5, 22.5)).toBe("color-mix(in srgb, var(--mt-info) 50%, var(--color-success))");
        expect(paceColour(0, UnusedBlueAt)).toBe("var(--mt-info)");
        expect(paceColour(0, 80)).toBe("var(--mt-info)");
        expect(UnusedBlueFrom).toBe(10);
        expect(UnusedBlueAt).toBe(35);
    });

    it("turns a week reset on Tuesday and unused on Thursday blue, and leaves the reset day green", () => {
        const thursdayLine = usageWeekLine(
            { id: "week", label: "This week", usedpercent: 0, resetsat: tuesday, windowmins: 10080 },
            thursday
        );
        expect(thursdayLine.unused).toBeCloseTo(28.57, 1);
        expect(paceColour(thursdayLine.pace, thursdayLine.unused)).toBe(
            "color-mix(in srgb, var(--mt-info) 74%, var(--color-success))"
        );
        // On the reset day itself little is allowed yet, so nothing used is still on pace.
        const resetDayLine = usageWeekLine(
            { id: "week", label: "This week", usedpercent: 0, resetsat: tuesday, windowmins: 10080 },
            new Date(2026, 10, 10, 20, 0).getTime()
        );
        expect(resetDayLine.unused).toBeLessThan(UnusedBlueFrom);
        expect(paceColour(resetDayLine.pace, resetDayLine.unused)).toBe("var(--color-success)");
    });

    it("reads blue from a theme token, never a raw colour", () => {
        expect(paceColour(0, 50)).not.toMatch(/#|rgb\(/);
    });
});

// #2102 reuses the grid for other usage surfaces: the model takes any list of windows.
describe("the week lines of a list of windows", () => {
    const windows = [
        { id: "session", label: "Current session", usedpercent: 30, resetsat: Now + 3600_000, windowmins: 300 },
        { id: "week", label: "This week", usedpercent: 40, resetsat: Now + 5 * Day, windowmins: 10080 },
        { id: "model:opus", label: "This week (Opus)", usedpercent: 70, resetsat: Now + 5 * Day, windowmins: 10080 },
        { id: "old", label: "This week", usedpercent: 99, resetsat: Now - 1, windowmins: 10080 },
    ];

    it("draws one line per running window, in the reader's order, with its start and pace", () => {
        const lines = usageWeekLines(windows, Now);
        expect(lines.map((l) => l.percent)).toEqual([30, 40, 70]);
        // The week last reset two days ago, on Wednesday: 40 % against 28.5 % allowed.
        expect(lines[1].start).toBe(2);
        expect(lines[1].pace).toBeCloseTo(40 / ((2 / 7) * 100), 5);
        expect(usageWeekLines(undefined, Now)).toEqual([]);
    });

    // The companion draws the per-model weekly window too (#2102): its line is paced against its own week, though it is
    // never a provider's main window.
    it("paces a per-model weekly window against a week, with the length the reader gave or a week without it", () => {
        const given = usageWeekLines(windows, Now)[2];
        // It resets on Wednesday 11 November, 5 days from Friday 6: it last reset on Wednesday 4 November.
        expect(given.windowMins).toBe(10080);
        expect(given.start).toBe(2);
        expect(given.pace).toBeCloseTo(70 / ((2 / 7) * 100), 5);
        const bare = usageWeekLine(
            { id: "model:opus", label: "This week (Opus)", usedpercent: 70, resetsat: Now + 5 * Day },
            Now
        );
        expect(bare.windowMins).toBe(10080);
        expect(bare.pace).toBeCloseTo(given.pace, 5);
        expect(windowLength({ id: "model:opus", label: "x", usedpercent: 1 })).toBe(10080);
        expect(windowLength({ id: "spend", label: "Spend limit", usedpercent: 1 })).toBe(0);
        expect(windowLength({ id: "session", label: "x", usedpercent: 1 })).toBe(300);
        expect(windowLength({ id: "other", label: "x", usedpercent: 1, windowmins: 43200 })).toBe(43200);
    });

    it("picks the main window: the longest running one, never per-model or spend", () => {
        expect(mainWindow(windows, Now).id).toBe("week");
        expect(mainWindow([windows[0]], Now).id).toBe("session");
        expect(mainWindow([windows[2], { id: "spend", label: "Spend limit", usedpercent: 9 }], Now)).toBeNull();
    });
});
