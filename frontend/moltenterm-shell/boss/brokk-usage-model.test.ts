// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { GravePercent, PaceRedAt, resetDay } from "../usage-week/usage-week-model";
import type { UsageReadings } from "./boss-usage";
import {
    AgentUse,
    choiceOf,
    planKind,
    readingStale,
    staleAfterMs,
    UsageContext,
    usageGrid,
    usageProviders,
    UseWindowMs,
    weeklyUsage,
    withChoice,
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

    it("selects Kimi's running calendar month and retains its id, raw label and reset", () => {
        const resetsat = Now + 20 * Day;
        const rows = weeklyUsage(
            {
                kimi: reading("kimi", [
                    { id: "session", usedpercent: 90 },
                    { id: "week", usedpercent: 50, resetsat: Now + 2 * Day },
                    { id: "month", label: "This month", usedpercent: 60, resetsat },
                ]),
            },
            Now
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            provider: "kimi",
            percent: 60,
            windowId: "month",
            windowLabel: "This month",
            resetsAt: resetsat,
        });
    });

    it("falls back to the running week when Kimi's month has expired", () => {
        const rows = weeklyUsage(
            {
                kimi: reading("kimi", [
                    { id: "session", usedpercent: 90 },
                    { id: "week", usedpercent: 50, resetsat: Now + 2 * Day },
                    { id: "month", label: "This month", usedpercent: 60, resetsat: Now - 1 },
                ]),
            },
            Now
        );
        expect(rows[0]).toMatchObject({ percent: 50, windowId: "week", windowLabel: "week" });
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
        expect(rows.map((r) => [r.provider, r.unreadable ?? "", r.windowId, r.windowLabel])).toEqual([
            ["claude", "", "week", "week"],
            ["codex", "expired", undefined, undefined],
        ]);
    });

    it("names the weekday of the reset in the language given", () => {
        const monday = new Date(2026, 10, 9, 8, 0, 0).getTime();
        expect(resetDay(monday, "fr")).toBe("lundi");
        expect(resetDay(monday, "en")).toBe("Monday");
        expect(resetDay(0, "en")).toBe("");
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

// ---- the use over 7 days (FR-BOSS-009, AC93 to AC98, #2341) -------------------------------------------------------------

const Minute = 60 * 1000;

function use(workMinutes: number, sessions = 1, lastDaysAgo = 1): AgentUse {
    return { workms: workMinutes * Minute, sessions, lastat: Now - lastDaysAgo * Day };
}

// A reading of a week taken a minute ago.
function fresh(agent: string, percent: number, plan = ""): UsageReadings[string] {
    return reading(agent, [{ id: "week", usedpercent: percent, resetsat: Now + 3 * Day }], Now - Minute, plan);
}

// What the free plan of a 30-day window gives: the window runs for weeks, so the reading outlives its week.
function monthly(agent: string, percent: number, daysAgo: number, plan = ""): UsageReadings[string] {
    return reading(
        agent,
        [{ id: "window:43200", usedpercent: percent, resetsat: Now + 20 * Day, windowmins: 43200 }],
        Now - daysAgo * Day,
        plan
    );
}

const ids = (rows: { provider: string }[]) => rows.map((r) => r.provider);

describe("the usage grid is ordered by use (FR-BOSS-009, AC93)", () => {
    it("puts the provider worked with most over the last 7 days first, whatever the fullness of its window", () => {
        const readings = { claude: fresh("claude", 100), codex: fresh("codex", 20), other: fresh("other", 60) };
        const ctx: UsageContext = { use: { claude: use(10), codex: use(120), other: use(45) } };
        expect(ids(weeklyUsage(readings, Now, undefined, ctx))).toEqual(["codex", "other", "claude"]);
    });

    it("ranks by working time before sessions, then by sessions when no time is known", () => {
        const readings = { a: fresh("a", 10), b: fresh("b", 10), c: fresh("c", 10) };
        const ctx: UsageContext = { use: { a: use(5, 1), b: use(0, 9), c: use(0, 3) } };
        expect(ids(weeklyUsage(readings, Now, undefined, ctx))).toEqual(["a", "b", "c"]);
    });

    it("puts the most recently used provider on top, whatever its work time (#2431)", () => {
        const readings = {
            a: reading("a", [{ id: "week", usedpercent: 10, resetsat: Now + 3 * Day }], Now - 3 * Day),
            b: fresh("b", 10),
        };
        const ctx: UsageContext = {
            use: { a: { workms: 50 * Minute, sessions: 9, lastat: Now - 3 * Day }, b: use(1, 1, 1) },
        };
        expect(ids(weeklyUsage(readings, Now, undefined, ctx))).toEqual(["b", "a"]);
    });

    it("breaks a tie by the fullest window, then by name", () => {
        const readings = { b: fresh("b", 40), a: fresh("a", 40), c: fresh("c", 70) };
        const ctx: UsageContext = { use: { a: use(30), b: use(30), c: use(30) } };
        expect(ids(weeklyUsage(readings, Now, undefined, ctx))).toEqual(["c", "a", "b"]);
    });

    it("keeps the fullest first when the use is not known yet, as before", () => {
        const readings = { a: fresh("a", 10), b: fresh("b", 80) };
        expect(ids(weeklyUsage(readings, Now, undefined, { use: null }))).toEqual(["b", "a"]);
        expect(ids(weeklyUsage(readings, Now))).toEqual(["b", "a"]);
    });

    it("lists a provider that cannot be read after the ones that can, whatever its use", () => {
        const ctx: UsageContext = { use: { codex: use(500), claude: use(1) } };
        expect(ids(weeklyUsage({ claude: fresh("claude", 20) }, Now, { codex: "expired" }, ctx))).toEqual([
            "claude",
            "codex",
        ]);
    });

    it("gives the detail panel the same order, without the providers the grid leaves out", () => {
        const readings = {
            claude: fresh("claude", 95),
            codex: fresh("codex", 20),
            old: monthly("old", 100, 12, "free"),
        };
        const ctx: UsageContext = { use: { claude: use(10), codex: use(100) } };
        expect(usageProviders(readings, Now, ctx).map((p) => p.id)).toEqual(["codex", "claude"]);
        expect(ids(weeklyUsage(readings, Now, undefined, ctx))).toEqual(["codex", "claude"]);
    });
});

describe("a provider not used within the window is left out (FR-BOSS-009, AC95, #2431)", () => {
    // The case of the ticket: a plan no longer paid, hardly used, a red 100 % first.
    it("hides a free plan with no use and no reading for 7 days, and lists it with its last reading", () => {
        const readings = { codex: monthly("codex", 100, 10, "free"), claude: fresh("claude", 30, "") };
        const ctx: UsageContext = { use: { claude: use(20) } };
        const grid = usageGrid(readings, Now, undefined, ctx);
        expect(ids(grid.rows)).toEqual(["claude"]);
        expect(grid.hidden).toEqual([{ provider: "codex", plan: "free", lastUse: Now - 10 * Day, reason: "unused" }]);
    });

    it("hides an unknown plan the same way: its last reading is then older than 7 days", () => {
        const grid = usageGrid({ claude: monthly("claude", 100, 8, "") }, Now, undefined, { use: {} });
        expect(grid.rows).toEqual([]);
        expect(grid.hidden.map((h) => [h.provider, h.reason])).toEqual([["claude", "unused"]]);
    });

    it("keeps a paid plan even when it was not used", () => {
        const readings = { codex: monthly("codex", 5, 12, "plus"), claude: monthly("claude", 5, 12, "Max") };
        const grid = usageGrid(readings, Now, undefined, { use: {} });
        expect(ids(grid.rows).sort()).toEqual(["claude", "codex"]);
        expect(grid.hidden).toEqual([]);
    });

    it("follows the window the developer set in Settings, 7 days when unset (#2431)", () => {
        const readings = { codex: monthly("codex", 50, 5, "free") };
        const withWindow = (windowMs?: number) =>
            usageGrid(readings, Now, undefined, { use: { codex: use(1, 1, 3) }, windowMs });
        expect(ids(withWindow().rows)).toEqual(["codex"]);
        expect(ids(withWindow(7 * Day).rows)).toEqual(["codex"]);
        expect(withWindow(2 * Day).hidden.map((h) => h.provider)).toEqual(["codex"]);
    });

    it("keeps a free plan that was used, or read, in the last 7 days", () => {
        const used = usageGrid({ codex: monthly("codex", 50, 12, "free") }, Now, undefined, {
            use: { codex: use(0, 1, 2) },
        });
        expect(ids(used.rows)).toEqual(["codex"]);
        const read = usageGrid({ codex: monthly("codex", 50, 6, "free") }, Now, undefined, { use: {} });
        expect(ids(read.rows)).toEqual(["codex"]);
        const worked = usageGrid({ codex: monthly("codex", 50, 12, "free") }, Now, undefined, {
            use: { codex: use(3, 0) },
        });
        expect(ids(worked.rows)).toEqual(["codex"]);
    });

    it("hides nothing while the use is not known: it is not the same as unused", () => {
        const grid = usageGrid({ codex: monthly("codex", 100, 12, "free") }, Now, undefined, { use: null });
        expect(ids(grid.rows)).toEqual(["codex"]);
    });

    it("hides a provider whose reading cannot be read and that nobody used, and keeps one that was used", () => {
        expect(usageGrid({}, Now, { codex: "signedout" }, { use: {} }).hidden.map((h) => h.provider)).toEqual([
            "codex",
        ]);
        const used = usageGrid({}, Now, { codex: "signedout" }, { use: { codex: use(1) } });
        expect(ids(used.rows)).toEqual(["codex"]);
    });

    it("tells a free plan from a paid one by the name its reading gives", () => {
        const kinds = ["free", "Free", "guest", "none", "expired", "ended", "cancelled", "canceled", "free_workspace"];
        expect(kinds.map(planKind)).toEqual(kinds.map(() => "free"));
        const paid = ["plus", "pro", "prolite", "team", "business", "enterprise", "edu", "go", "Max"];
        expect(paid.map(planKind)).toEqual(paid.map(() => "paid"));
        expect(["", "  ", "unknown", undefined].map(planKind)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    });

    it("counts 7 days to the millisecond", () => {
        const at = (age: number) =>
            usageGrid({ codex: monthly("codex", 50, 0, "free") }, Now + age, undefined, { use: {} });
        // Read exactly 7 days ago: no longer in the last 7 days.
        expect(at(UseWindowMs).hidden).toHaveLength(1);
        expect(at(UseWindowMs - 1).hidden).toHaveLength(0);
    });
});

describe("the developer's choice (FR-BOSS-009, AC97)", () => {
    const readings = { codex: monthly("codex", 100, 12, "free"), claude: fresh("claude", 30, "Max") };

    it("keeps a provider in the grid whatever the rules say with Always show", () => {
        const grid = usageGrid(readings, Now, undefined, {
            use: { claude: use(5) },
            choices: { show: ["codex"], hide: [] },
        });
        expect(ids(grid.rows).sort()).toEqual(["claude", "codex"]);
        expect(grid.hidden).toEqual([]);
    });

    it("hides a paid provider with Hide, and lists it as chosen, with its last use", () => {
        const grid = usageGrid(readings, Now, undefined, {
            use: { claude: use(5, 2, 3) },
            choices: { show: [], hide: ["claude"] },
        });
        expect(ids(grid.rows)).toEqual([]);
        expect(grid.hidden.map((h) => [h.provider, h.reason])).toEqual([
            ["claude", "chosen"],
            ["codex", "unused"],
        ]);
        expect(grid.hidden[0].lastUse).toBe(Now - Minute);
    });

    it("hides a chosen provider even before the use is known", () => {
        const grid = usageGrid(readings, Now, undefined, { use: null, choices: { show: [], hide: ["claude"] } });
        expect(grid.hidden.map((h) => h.provider)).toEqual(["claude"]);
    });

    it("gives the provider back to the rules with Automatic", () => {
        let choices = withChoice({ show: [], hide: [] }, "codex", "show");
        expect(choiceOf(choices, "codex")).toBe("show");
        choices = withChoice(choices, "codex", "hide");
        expect(choices).toEqual({ show: [], hide: ["codex"] });
        choices = withChoice(choices, "claude", "show");
        expect(choices).toEqual({ show: ["claude"], hide: ["codex"] });
        choices = withChoice(choices, "codex", "auto");
        expect(choices).toEqual({ show: ["claude"], hide: [] });
        expect(choiceOf(choices, "codex")).toBe("auto");
        expect(choiceOf(undefined, "codex")).toBe("auto");
    });

    it("never lists a provider twice or in both lists", () => {
        const once = withChoice(withChoice({ show: ["a"], hide: [] }, "a", "show"), "a", "show");
        expect(once.show).toEqual(["a"]);
    });
});

describe("a stale reading never looks current (FR-BOSS-009, AC96)", () => {
    it("is older than its window, and than 7 days at most", () => {
        expect(staleAfterMs(300)).toBe(5 * 60 * Minute);
        expect(staleAfterMs(10080)).toBe(UseWindowMs);
        expect(staleAfterMs(43200)).toBe(UseWindowMs);
        expect(staleAfterMs(0)).toBe(UseWindowMs);
    });

    it("marks the row of a 30-day window read 8 days ago, and not one read 3 days ago", () => {
        const rows = weeklyUsage({ a: monthly("a", 100, 8, "plus"), b: monthly("b", 100, 3, "plus") }, Now);
        expect(rows.map((r) => [r.provider, r.stale]).sort()).toEqual([
            ["a", true],
            ["b", false],
        ]);
    });

    it("marks a 5-hour session read 6 hours ago, and only that", () => {
        const session = (hoursAgo: number) =>
            reading(
                "claude",
                [{ id: "session", usedpercent: 90, resetsat: Now + 3600_000, windowmins: 300 }],
                Now - hoursAgo * 3600_000
            );
        expect(weeklyUsage({ claude: session(6) }, Now)[0].stale).toBe(true);
        expect(weeklyUsage({ claude: session(2) }, Now)[0].stale).toBe(false);
    });

    it("does not mark a reading with no time, an unreadable provider, or a week read yesterday", () => {
        expect(weeklyUsage({ a: reading("a", [{ id: "week", usedpercent: 50 }], 0) }, Now)[0].stale).toBe(false);
        expect(weeklyUsage({}, Now, { a: "failed" })[0].stale).toBe(false);
        expect(weeklyUsage({ a: fresh("a", 99) }, Now)[0].stale).toBe(false);
    });

    it("does not rank a stale full window above a current one that is less full", () => {
        const readings = { a: monthly("a", 100, 8, "plus"), b: fresh("b", 30, "") };
        expect(ids(weeklyUsage(readings, Now, undefined, { use: {} }))).toEqual(["b", "a"]);
    });

    it("tells Brokk's usage visit that a stale reading is no news", () => {
        expect(readingStale(monthly("a", 100, 8, "plus"), Now)).toBe(true);
        expect(readingStale(fresh("a", 100), Now)).toBe(false);
        expect(readingStale(null, Now)).toBe(false);
    });
});
