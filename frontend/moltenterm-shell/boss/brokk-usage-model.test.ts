// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import En from "../i18n/locales/en.json";
import Fr from "../i18n/locales/fr.json";
import type { UsageReadings } from "./boss-usage";
import {
    dayFills,
    GravePercent,
    lastReset,
    paceColour,
    PaceOrangeAt,
    paceRatio,
    PaceRedAt,
    resetDay,
    startIndex,
    usageProviders,
    weekdayIndex,
    WeekDayKeys,
    weeklyUsage,
} from "./brokk-usage-model";

const Now = new Date(2026, 10, 6, 10, 0, 0).getTime();
const Day = 24 * 60 * 60 * 1000;

type Win = { id: string; label?: string; usedpercent: number; resetsat?: number; windowmins?: number };

function reading(agent: string, windows: Win[], readat = Now, plan = ""): UsageReadings[string] {
    return {
        agent,
        source: "test",
        plan,
        readat,
        windows: windows.map((w) => ({ label: w.id, ...w })),
    };
}

function percents(agent: string, values: number[], readat = Now, plan = ""): UsageReadings[string] {
    return reading(
        agent,
        values.map((usedpercent, i) => ({ id: `w${i}`, usedpercent })),
        readat,
        plan
    );
}

describe("the weekly usage under the square (FR-BOSS-009, AC17 and AC20)", () => {
    it("gives the weekly window of each provider as a rounded percent, the fullest first", () => {
        const rows = weeklyUsage(
            {
                codex: reading("codex", [{ id: "week", usedpercent: 31.2, resetsat: Now + 3 * Day }]),
                claude: reading("claude", [
                    { id: "session", usedpercent: 95 },
                    { id: "week", usedpercent: 61.6, resetsat: Now + 2 * Day },
                ]),
            },
            Now
        );
        expect(rows.map((r) => [r.provider, r.percent])).toEqual([
            ["claude", 62],
            ["codex", 31],
        ]);
    });

    it("reads the longest window: the week over the 5-hour session, which shows only when it is the only one", () => {
        const rows = weeklyUsage(
            {
                claude: reading("claude", [
                    { id: "session", usedpercent: 99 },
                    { id: "week", usedpercent: 20 },
                    { id: "model:opus", usedpercent: 70, windowmins: 10080 },
                    { id: "spend", usedpercent: 80 },
                ]),
                other: reading("other", [{ id: "session", usedpercent: 12 }]),
            },
            Now
        );
        expect(rows.map((r) => [r.provider, r.percent])).toEqual([
            ["claude", 20],
            ["other", 12],
        ]);
    });

    // #2100: Codex's free plan reads a 30-day window only, and had no row.
    it("gives a provider with only a 30-day window a row, with its length", () => {
        const rows = weeklyUsage(
            {
                codex: reading("codex", [
                    { id: "window:43200", usedpercent: 47, resetsat: Now + 29 * Day, windowmins: 43200 },
                ]),
            },
            Now
        );
        expect(rows.map((r) => [r.provider, r.percent, r.windowMins])).toEqual([["codex", 47, 43200]]);
    });

    it("finds a week by its length when the reader gave it no name", () => {
        const rows = weeklyUsage(
            { codex: reading("codex", [{ id: "window:10080", usedpercent: 40, windowmins: 10080 }]) },
            Now
        );
        expect(rows.map((r) => r.percent)).toEqual([40]);
    });

    it("without a reset time, reads a window above 90 % as far ahead of its pace and any other as on pace", () => {
        const rows = weeklyUsage(
            {
                a: reading("a", [{ id: "week", usedpercent: GravePercent }]),
                b: reading("b", [{ id: "week", usedpercent: GravePercent + 1 }]),
            },
            Now
        );
        const byProvider = Object.fromEntries(rows.map((r) => [r.provider, r.pace > PaceRedAt]));
        expect(byProvider).toEqual({ a: false, b: true });
    });

    it("judges the pace from the time gone since the last reset: two days into a week allow 28.5 %", () => {
        const rows = weeklyUsage(
            { claude: reading("claude", [{ id: "week", usedpercent: 40, resetsat: Now + 5 * Day }]) },
            Now
        );
        expect(rows[0].pace).toBeCloseTo(40 / ((2 / 7) * 100), 5);
    });

    it("keeps the reset time for the tooltip", () => {
        const rows = weeklyUsage(
            { claude: reading("claude", [{ id: "week", usedpercent: 10, resetsat: Now + Day }]) },
            Now
        );
        expect(rows[0].resetsAt).toBe(Now + Day);
    });

    it("leaves out a week already past its reset, a provider without a week, and says nothing without any reading", () => {
        expect(weeklyUsage({ a: reading("a", [{ id: "week", usedpercent: 50, resetsat: Now - 1 }]) }, Now)).toEqual([]);
        expect(weeklyUsage({ a: reading("a", []) }, Now)).toEqual([]);
        expect(weeklyUsage({}, Now)).toEqual([]);
        expect(weeklyUsage(undefined, Now)).toEqual([]);
    });

    it("takes one reading per provider: the latest", () => {
        const rows = weeklyUsage(
            {
                a: reading("claude", [{ id: "week", usedpercent: 90 }], Now - 5000),
                b: reading("claude", [{ id: "week", usedpercent: 15 }], Now),
            },
            Now
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].percent).toBe(15);
    });

    // #2074: a Pro Lite reading has one weekly window and no secondary; a day-old one still shows, with its age.
    it("shows an old reading of a running week, marked old", () => {
        const rows = weeklyUsage(
            {
                codex: reading(
                    "codex",
                    [{ id: "week", usedpercent: 9, resetsat: Now + 4 * Day }],
                    Now - Day,
                    "prolite"
                ),
            },
            Now
        );
        expect(rows.map((r) => [r.provider, r.percent, r.old, r.readAt])).toEqual([["codex", 9, true, Now - Day]]);
        const fresh = weeklyUsage({ codex: reading("codex", [{ id: "week", usedpercent: 9 }], Now - 60000) }, Now);
        expect(fresh[0].old).toBe(false);
    });

    it("lists an unreadable provider last, without a percent, unless it has a running week", () => {
        const rows = weeklyUsage({ claude: reading("claude", [{ id: "week", usedpercent: 20 }]) }, Now, {
            codex: "expired",
            claude: "failed",
        });
        expect(rows.map((r) => [r.provider, r.unreadable ?? ""])).toEqual([
            ["claude", ""],
            ["codex", "expired"],
        ]);
    });

    it("names the weekday of the reset in the language given", () => {
        const monday = new Date(2026, 10, 9, 8, 0, 0).getTime();
        expect(resetDay(monday, "fr")).toBe("lundi");
        expect(resetDay(monday, "en")).toBe("Monday");
        expect(resetDay(0, "en")).toBe("");
    });
});

describe("the week grid of the usage block (FR-BOSS-009, AC48 to AC51, #2100)", () => {
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
        const initials = (dict: any) => WeekDayKeys.map((key) => dict.boss.group.usage.day[key]).join("");
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

describe("the usage detail lists the plan usage of every provider (FR-BOSS-006)", () => {
    it("puts the fullest provider first, with its plan and one row per running window", () => {
        const providers = usageProviders(
            { codex: percents("codex", [20, 35]), claude: percents("claude", [10, 80], Now, "Max") },
            Now
        );
        expect(providers.map((p) => p.id)).toEqual(["claude", "codex"]);
        expect(providers[0].plan).toBe("Max");
        expect(providers[0].rows).toHaveLength(2);
        expect(providers[0].fullest).toBe(80);
    });

    it("leaves out a provider with no running window, and says nothing without any reading", () => {
        expect(usageProviders({ claude: percents("claude", []) }, Now)).toEqual([]);
        expect(usageProviders({}, Now)).toEqual([]);
        expect(usageProviders(undefined, Now)).toEqual([]);
    });

    it("takes one reading per provider: the latest", () => {
        const providers = usageProviders(
            { a: percents("claude", [90], Now - 5000), b: percents("claude", [15], Now) },
            Now
        );
        expect(providers).toHaveLength(1);
        expect(providers[0].fullest).toBe(15);
    });

    it("keeps the windows the weekly block does not show (5-hour session, per model), with their reset times", () => {
        const providers = usageProviders(
            {
                claude: reading("claude", [
                    { id: "session", label: "Current session", usedpercent: 30, resetsat: Now + 3600_000 },
                    { id: "week", label: "This week", usedpercent: 60, resetsat: Now + 2 * Day },
                    { id: "model:opus", label: "This week (Opus)", usedpercent: 20, resetsat: Now + 2 * Day },
                ]),
            },
            Now
        );
        expect(providers[0].rows.map((r) => r.id)).toEqual(["session", "week", "model:opus"]);
        expect(providers[0].rows.every((r) => r.resetsShort !== "")).toBe(true);
    });
});
