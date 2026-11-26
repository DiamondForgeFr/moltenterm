// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The month in the companion and in Brokk's grid (#2532, FR-SHELL-018, FR-BOSS-009 AC109 to AC112), as the rows of the
// validated mockup draw it (https://claude.ai/artifact/LyVT1guodQk6xReNiSKnBw): the month read like a week, one calendar
// week at a time, its days late or ahead, the share lost with its days hatched at the end of the window. And what must
// not move: the session ring (#2473), the pace colours and the under-use blue (#2106), the figures under the blocks, the
// count to the monthly reset, "< 1 %" (#2451), the weekly windows and the narrow-column behaviours.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UsageReadings } from "../boss/boss-usage";
import { weekRow } from "../boss/brokk-usage-block";
import { usageGrid } from "../boss/brokk-usage-model";
import { I18nModel } from "../i18n/i18n";
import { UsageWeekGrid } from "../usage-week/usage-week";
import { MinFigureBlockPx, paceColour } from "../usage-week/usage-week-model";
import { PlanUsageBody, UsageFrame } from "./companion-gauges";
import { CompanionUsageInfo, gaugeRows, gaugesView, UsageWindow } from "./companion-gauges-model";

vi.mock("@/app/store/wos", () => ({ makeORef: (t: string, id: string) => `${t}:${id}` }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));

const Min = 60 * 1000;
const Hour = 60 * Min;
const at = (month: number, day: number, hour = 0, minute = 0, year = 2024) =>
    new Date(year, month - 1, day, hour, minute).getTime();
// Wednesday 10 January 2024, 12:00 local: a 31-day month that reset on Monday 1 January, on 1 February.
const now = at(1, 10, 12);
const FebruaryFirst = at(2, 1);
const HalfADay = (0.5 / 31) * 100;

const session: UsageWindow = {
    id: "session",
    label: "Current session",
    usedpercent: 15,
    resetsat: now + Hour + 20 * Min,
    windowmins: 300,
};

function kimiAt(readingNow: number, windows: UsageWindow[], extra: Partial<CompanionUsageInfo["snapshot"]> = {}) {
    const info: CompanionUsageInfo = {
        blockid: "k1",
        agent: "kimi",
        pageurl: "https://www.kimi.ai/code/console",
        pagename: "Kimi usage",
        hasgauges: true,
        gauges: "enabled",
        sourcename: "Kimi Code managed usage endpoint",
        snapshot: { agent: "kimi", source: "kimi-oauth", readat: readingNow - 2 * Min, windows, ...extra },
    };
    return info;
}

const monthWindow = (used: number, extra: Partial<UsageWindow> = {}, resetsat = FebruaryFirst): UsageWindow => ({
    id: "month",
    label: "This month",
    usedpercent: used,
    resetsat,
    ...extra,
});

const kimi = kimiAt(now, [session, monthWindow(HalfADay)]);

const claude: CompanionUsageInfo = {
    blockid: "c1",
    agent: "claude",
    pageurl: "https://claude.ai/settings/usage",
    pagename: "Claude usage",
    hasgauges: true,
    gauges: "enabled",
    sourcename: "Claude Code status line",
    snapshot: {
        agent: "claude",
        source: "claude-statusline",
        readat: now - 3 * Min,
        windows: [
            { ...session, usedpercent: 40 },
            { id: "week", label: "This week", usedpercent: 63, resetsat: at(1, 16, 9), windowmins: 10080 },
        ],
    },
};

const noop = { onShow: () => {}, onHide: () => {}, onRefresh: () => {} };

function markup(info: CompanionUsageInfo, at = now): string {
    return renderToStaticMarkup(<PlanUsageBody view={gaugesView(info, at)} {...noop} />);
}

const frame: UsageFrame = ({ tools, body }) => (
    <div>
        {tools}
        {body}
    </div>
);

function framed(info: CompanionUsageInfo, form: "full" | "minimal" | "attached", at = now): string {
    return renderToStaticMarkup(<PlanUsageBody view={gaugesView(info, at)} {...noop} frame={frame} form={form} />);
}

const RowStart = '<span class="mt-uw-row"';
const rowTag = (html: string, window: string): string =>
    [...html.matchAll(/<span class="mt-uw-row"[^>]*>/g)]
        .map((m) => m[0])
        .find((tag) => tag.includes(`data-window="${window}"`)) ?? "";
const rowHtml = (html: string, window: string): string => {
    const start = html.indexOf(rowTag(html, window));
    const next = html.indexOf(RowStart, start + 1);
    return html.slice(start, next < 0 ? html.length : next);
};
type Block = { fill: number; reset: boolean; today: boolean; out: boolean; lost: number };
const blocksOf = (html: string, window: string): Block[] =>
    [
        ...rowHtml(html, window).matchAll(
            /<span class="mt-uw-cell([^"]*)"[^>]*data-testid="usage-week-block"[^>]*>(.*?)<\/span>/g
        ),
    ].map((m) => ({
        fill: Number(/<i style="width:([0-9.]+)%"/.exec(m[2])?.[1]),
        reset: m[1].includes("is-reset"),
        today: m[1].includes("is-today"),
        out: m[1].includes("is-out"),
        lost: Number(/class="mt-uw-lost" style="width:([0-9.]+)%"/.exec(m[2])?.[1] ?? 0),
    }));
const percentOf = (html: string, window: string): string =>
    /data-testid="usage-week-percent">([^<]*)</.exec(rowHtml(html, window))?.[1] ?? "";
const sharesOf = (html: string, window: string): string[] =>
    [
        ...rowHtml(html, window).matchAll(
            /<span class="mt-uw-share[^"]*"[^>]*?(data-out="true"|data-lost="true"|data-share="(\d+)")/g
        ),
    ].map((m) => m[2] ?? (m[1].includes("out") ? "out" : "lost"));
const textOf = (html: string, window: string, testid: string): string =>
    new RegExp(`data-testid="${testid}">([^<]*)<`).exec(rowHtml(html, window))?.[1] ?? "";
const ringTag = (html: string): string => /<span class="mt-uw-ring"[^>]*>/.exec(html)?.[0] ?? "";
// The week a monthly row shows, in the line under it (#2565): its short count then its days, "Wk 2/5 · 8–14 Jan".
const weeksOf = (html: string, window: string): string[] =>
    (/data-testid="usage-week-weeks">([^<]*)</.exec(rowHtml(html, window))?.[1] ?? "").split(" · ");
const buttonOf = (html: string, dir: "prev" | "next"): string =>
    new RegExp(`<button[^>]*data-testid="usage-week-${dir}"[^>]*>`).exec(html)?.[0] ?? "";

// ---- the month spread over its days, from the reset (rows 2 and 3) ----

describe("the month in the companion, read like a week (#2532)", () => {
    it("is a row of the week grid: 'Consumption', over the month, seven blocks, then the week it shows and its two controls in the line under it", () => {
        const html = markup(kimi);
        expect(rowTag(html, "month")).toContain('data-monthly="true"');
        expect(rowTag(html, "month")).not.toContain("data-plain");
        expect(html).toContain(
            'data-testid="usage-week-label">Consumption<span class="mt-uw-label-sub" data-testid="usage-week-sublabel">over the month</span>'
        );
        // Wednesday 10 January is in the second of the five weeks of the month.
        expect(rowTag(html, "month")).toContain('data-week="2"');
        expect(weeksOf(html, "month")).toEqual(["Wk 2/5", expect.stringMatching(/8.*14/)]);
        expect(blocksOf(html, "month")).toHaveLength(7);
        // The caption is no longer under the label, and no column of the grid is the controls' (#2565).
        expect(rowHtml(html, "month")).toContain('over the month</span></span><span class="mt-uw-cell"');
        expect(html).not.toContain("data-nav");
        expect(buttonOf(html, "prev")).toContain('aria-label="Previous week"');
        expect(buttonOf(html, "next")).toContain('aria-label="Next week"');
        expect(buttonOf(html, "prev")).not.toContain("disabled");
        expect(buttonOf(html, "next")).not.toContain("disabled");
        // The controls are real buttons with an icon, not characters, and never a native tooltip.
        expect(buttonOf(html, "prev")).toContain('type="button"');
        expect(buttonOf(html, "prev")).not.toContain("title=");
        expect(rowHtml(html, "month")).toContain("lucide-chevron-left");
        expect(rowHtml(html, "month")).toContain("lucide-chevron-right");
    });

    it("opens on the week holding today, which is lit, with the days not worked empty and owed (row 2)", () => {
        const html = markup(kimi);
        const blocks = blocksOf(html, "month");
        expect(blocks.map((b) => b.fill)).toEqual([0, 0, 0, 0, 0, 0, 0]);
        expect(blocks.map((b) => b.today)).toEqual([false, false, true, false, false, false, false]);
        expect(blocks.some((b) => b.reset || b.out)).toBe(false);
        // 9 days late, said under the row, in the row's own words.
        expect(textOf(html, "month", "usage-week-late")).toBe("9 d late");
        expect(percentOf(html, "month")).toBe("2 %");
        expect(rowTag(html, "month")).toContain("Week 2 of 5");
        expect(rowTag(html, "month")).toContain("9 d late");
    });

    it("keeps the count to the monthly reset, its reset icon and its percent, in order, in every form", () => {
        for (const html of [markup(kimi), framed(kimi, "full"), framed(kimi, "minimal"), framed(kimi, "attached")]) {
            const month = rowHtml(html, "month");
            // 21 days and 12 hours to Thursday 1 February: whole days, as the count has always been.
            expect(month).toContain('data-testid="usage-week-chip">21 d<');
            expect(month).toContain('data-tip="Monthly reset in 21 days, Thu 1 Feb, 00:00"');
            expect(month.indexOf("usage-week-reset")).toBeLessThan(month.indexOf("usage-week-chip"));
            expect(month.indexOf("usage-week-chip")).toBeLessThan(month.indexOf("usage-week-percent"));
            expect(month).toContain('aria-label="Resets Thu 1 Feb, 00:00"');
            expect(rowTag(html, "month")).toContain("Monthly reset in 21 days, Thu 1 Feb, 00:00");
        }
    });

    it("counts the days of the month from the first column, in the minimal and attached forms too (row 2)", () => {
        for (const form of ["minimal", "attached"] as const) {
            const html = framed(kimi, form);
            expect(rowTag(html, "month")).toContain('data-monthly="true"');
            expect(rowTag(html, "month")).toContain("9 d late");
            expect(rowTag(html, "month")).toMatch(/per day: Mon 0 %, Tue 0 %, Wed 0 %/);
            expect(buttonOf(html, "next")).toContain("Next week");
        }
    });

    it("tells the figures of its days in its tooltip, and how a month reads", () => {
        const html = markup(kimi);
        expect(rowTag(html, "month")).toContain(
            "Per day: Mon 0 %, Tue 0 %, Wed 0 %, Thu 0 %, Fri 0 %, Sat 0 %, Sun 0 %"
        );
        expect(rowTag(html, "month")).toContain("A day not worked stays owed");
    });
});

describe("browsing the weeks of the month (rows 2, 3 and 5)", () => {
    const row = (used: number, extra: Partial<UsageWindow>, resetsat: number, readingNow: number) => {
        const month = monthWindow(used, extra, resetsat);
        const [r] = gaugeRows(kimiAt(readingNow, [session, month]).snapshot, readingNow).filter(
            (x) => x.id === "month"
        );
        return {
            key: "month",
            agent: "kimi",
            name: r.label,
            window: "month",
            label: r.leadLabel,
            sublabel: r.subLabel,
            line: r.line,
        };
    };
    const grid = (
        week: number | undefined,
        used = HalfADay,
        extra: Partial<UsageWindow> = {},
        resetsat = FebruaryFirst,
        readingNow = now
    ) =>
        renderToStaticMarkup(
            <UsageWeekGrid
                rows={[row(used, extra, resetsat, readingNow)]}
                now={readingNow}
                dayFigures
                initialWeeks={week == null ? undefined : { month: week }}
            />
        );

    it("moves from a week to the next and the previous, and stops at both ends: both controls are named, the end one dimmed", () => {
        const first = grid(0);
        expect(rowTag(first, "month")).toContain('data-week="1"');
        expect(buttonOf(first, "prev")).toContain("disabled");
        expect(buttonOf(first, "next")).not.toContain("disabled");
        expect(weeksOf(first, "month")[0]).toBe("Wk 1/5");
        const last = grid(4);
        expect(rowTag(last, "month")).toContain('data-week="5"');
        expect(buttonOf(last, "next")).toContain("disabled");
        expect(buttonOf(last, "prev")).not.toContain("disabled");
        expect(weeksOf(last, "month")[0]).toBe("Wk 5/5");
        const middle = grid(2);
        expect(buttonOf(middle, "prev")).not.toContain("disabled");
        expect(buttonOf(middle, "next")).not.toContain("disabled");
        // A week asked for past the window is the last, never another month's.
        expect(rowTag(grid(9), "month")).toContain('data-week="5"');
        expect(rowTag(grid(-3), "month")).toContain('data-week="1"');
    });

    it("wires each control to its own step, and keeps the week the developer picked while the window runs", () => {
        const source = readFileSync(join(__dirname, "../usage-week/usage-week.tsx"), "utf8");
        const prev = /<WeekButton\s+dir="prev"[\s\S]*?onClick=\{\(\) => onMove\(stepWeek\(([^)]*)\)\)\}/.exec(source);
        const next = /<WeekButton\s+dir="next"[\s\S]*?onClick=\{\(\) => onMove\(stepWeek\(([^)]*)\)\)\}/.exec(source);
        expect(prev?.[1]).toBe('index, count, "prev"');
        expect(next?.[1]).toBe('index, count, "next"');
        expect(source).toContain(
            "<WeekControls caption={caption} index={pager.index} count={pager.weeks.count} onMove={moveTo} />"
        );
        // A pick is kept for the window it was made in: another reset time (the month turned) drops it.
        expect(source).toContain("pick.reset == null || pick.reset === line.resetsAt");
        expect(source).toContain("setPicks({ ...picks, [row.key]: { reset: line.resetsAt, index } })");
    });

    it("shows the half day used on the 1st in the week of the 1st, and nothing in the others (row 3)", () => {
        const first = grid(0);
        const blocks = blocksOf(first, "month");
        expect(blocks.map((b) => b.fill)).toEqual([50, 0, 0, 0, 0, 0, 0]);
        // Row 3 draws the reset day with its ring and no mark of today.
        expect(blocks[0].reset).toBe(true);
        expect(blocks.some((b) => b.today)).toBe(false);
        expect(sharesOf(first, "month")).toEqual(["50", "0", "0", "0", "0", "0", "0"]);
        for (const week of [2, 3, 4]) {
            expect(blocksOf(grid(week), "month").every((b) => b.fill === 0 && !b.reset && !b.today)).toBe(true);
        }
    });

    it("fills a catch-up where it reaches, the weeks before it full (row 4)", () => {
        const second = grid(1, 30);
        expect(blocksOf(second, "month").map((b) => b.fill)).toEqual([100, 100, 30, 0, 0, 0, 0]);
        expect(sharesOf(second, "month")).toEqual(["100", "100", "30", "0", "0", "0", "0"]);
        expect(blocksOf(grid(0, 30), "month").every((b) => b.fill === 100)).toBe(true);
        expect(textOf(second, "month", "usage-week-late")).toBe("on time");
    });

    it("greys the days outside the window, dashed and empty, with no figure (rows 5 and 6)", () => {
        const last = grid(4, 40);
        expect(blocksOf(last, "month").map((b) => b.out)).toEqual([false, false, false, true, true, true, true]);
        expect(sharesOf(last, "month")).toEqual(["0", "0", "0", "out", "out", "out", "out"]);
        // Row 6: a reset on Wednesday 17 January, so the first two days of its week come before the window; it is Friday 19.
        const midWeek = grid(0, 12, {}, at(2, 17), at(1, 19, 12));
        expect(blocksOf(midWeek, "month").map((b) => b.out)).toEqual([true, true, false, false, false, false, false]);
        expect(blocksOf(midWeek, "month").map((b) => b.fill)).toEqual([0, 0, 100, 100, 100, 72, 0]);
        expect(sharesOf(midWeek, "month")).toEqual(["out", "out", "100", "100", "100", "72", "0"]);
        expect(blocksOf(midWeek, "month").map((b) => b.reset)).toEqual([
            false,
            false,
            true,
            false,
            false,
            false,
            false,
        ]);
        expect(weeksOf(midWeek, "month")[0]).toBe("Wk 1/5");
        // 3.72 days used of the 2.5 gone: 1.2 days ahead.
        expect(textOf(midWeek, "month", "usage-week-late")).toBe("1.2 d ahead");
    });

    it("styles the day outside the window as a dashed empty block, and keeps its figure's place in the line below", () => {
        const css = readFileSync(join(__dirname, "../usage-week/usage-week.css"), "utf8").replace(
            /\/\*[\s\S]*?\*\//g,
            ""
        );
        expect(/\.mt-uw-cell\.is-out \{([^}]*)\}/.exec(css)?.[1]).toMatch(/outline: 1px dashed/);
        const last = grid(4, 40);
        // The cells of the figures' line are all there, empty for an outside day, so the columns keep their places.
        const pads = [...last.matchAll(/class="mt-uw-share-pad"/g)].length;
        expect(pads).toBe(2);
        expect(sharesOf(last, "month")).toHaveLength(7);
    });
});

// ---- the share lost (row 5) ----

describe("the share lost, hatched at the end of the window and left out of the days late (row 5)", () => {
    // Thursday 25 January 2024, noon: 40 % of the month used, a full session worth 1.5 % of it.
    const lateNow = at(1, 25, 12);
    const measured = kimiAt(lateNow, [
        { ...session, resetsat: lateNow + 2 * Hour },
        monthWindow(40, { sessionworth: 1.5, sessionmins: 300 }),
    ]);
    const unmeasured = kimiAt(lateNow, [{ ...session, resetsat: lateNow + 2 * Hour }, monthWindow(40)]);

    it("tells the days late without the lost days, the lost share in percent then in days, and hatches the last days", () => {
        const html = markup(measured, lateNow);
        expect(textOf(html, "month", "usage-week-late")).toBe("8 d late");
        expect(textOf(html, "month", "usage-week-lost")).toBe("13 % lost (4 d)");
        expect(rowHtml(html, "month")).toContain('data-testid="usage-week-pace-note" data-lost="true"');
        expect(rowTag(html, "month")).toContain("8 d late");
        expect(rowTag(html, "month")).toContain("13 % lost (4 d)");
        // The week of 29 to 31 January is lost, its figures say so, and the days after it are outside the window.
        const row = rowHtml(html, "month");
        expect(weeksOf(html, "month")[0]).toBe("Wk 4/5");
        expect(rowTag(html, "month")).toContain("Week 4 of 5");
        const last = renderToStaticMarkup(
            <UsageWeekGrid
                rows={[
                    {
                        key: "month",
                        agent: "kimi",
                        name: "This month",
                        window: "month",
                        label: "Consumption",
                        line: gaugeRows(measured.snapshot, lateNow).find((r) => r.id === "month").line,
                    },
                ]}
                now={lateNow}
                dayFigures
                initialWeeks={{ month: 4 }}
            />
        );
        expect(blocksOf(last, "month").map((b) => b.lost)).toEqual([100, 100, 100, 0, 0, 0, 0]);
        expect(blocksOf(last, "month").map((b) => b.out)).toEqual([false, false, false, true, true, true, true]);
        expect(sharesOf(last, "month")).toEqual(["lost", "lost", "lost", "out", "out", "out", "out"]);
        expect(last).toContain('<span class="mt-uw-fig">lost</span>');
    });

    it("hatches the end of a day the lost part reaches only in part", () => {
        const html = renderToStaticMarkup(
            <UsageWeekGrid
                rows={[
                    {
                        key: "month",
                        agent: "kimi",
                        name: "This month",
                        window: "month",
                        label: "Consumption",
                        line: gaugeRows(measured.snapshot, lateNow).find((r) => r.id === "month").line,
                    },
                ]}
                now={lateNow}
                initialWeeks={{ month: 3 }}
            />
        );
        // 22 to 28 January: the 27th loses its last 9.2 %, the 28th all of it.
        expect(blocksOf(html, "month").map((b) => b.lost)).toEqual([0, 0, 0, 0, 0, 9.2, 100]);
    });

    it("tells 12 days late when nothing is measured, and hatches nothing", () => {
        const html = markup(unmeasured, lateNow);
        expect(textOf(html, "month", "usage-week-late")).toBe("12 d late");
        expect(html).not.toContain('data-testid="usage-week-lost"');
        expect(html).not.toContain("mt-uw-lost");
        expect(rowHtml(html, "month")).not.toContain('data-lost="true"');
        expect(rowTag(html, "month")).not.toContain("lost");
    });

    it("tells nothing of it for a plan without a session window", () => {
        const noSession = kimiAt(lateNow, [monthWindow(40, { sessionworth: 1.5 })]);
        const html = markup(noSession, lateNow);
        expect(html).not.toContain('data-testid="usage-week-lost"');
        expect(html).not.toContain("mt-uw-lost");
        // Any day not worked can still be caught up: the days late are all of them.
        expect(textOf(html, "month", "usage-week-late")).toBe("12 d late");
    });

    it("tells it in French: '13 % perdus (4 j)', '8 j de retard', 'perdu' in the blocks", () => {
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            const html = markup(measured, lateNow);
            expect(textOf(html, "month", "usage-week-late")).toBe("8 j de retard");
            expect(textOf(html, "month", "usage-week-lost")).toBe("13 % perdus (4 j)");
            expect(html).toContain('data-testid="usage-week-sublabel">sur le mois<');
            expect(buttonOf(html, "prev")).toContain('aria-label="Semaine précédente"');
            expect(buttonOf(html, "next")).toContain('aria-label="Semaine suivante"');
            expect(weeksOf(html, "month")[0]).toBe("Sem. 4/5");
            expect(rowTag(html, "month")).toContain("Semaine 4 sur 5");
        } finally {
            i18n.setLanguageSetting("");
        }
    });
});

// ---- days late or ahead, weekly windows alike (row 7) ----

describe("days late or ahead of a weekly window (row 7)", () => {
    it("tells Claude Code's week in days, and leaves its blocks and its other words as they were", () => {
        const html = markup(claude);
        expect(rowTag(html, "week")).not.toContain("data-monthly");
        expect(rowTag(html, "week")).not.toContain("data-plain");
        expect(html).not.toContain("data-nav");
        expect(html).not.toContain("usage-week-prev");
        expect(blocksOf(html, "week")).toHaveLength(7);
        // 63 % from a Tuesday reset (Tuesday to Friday full, Saturday 41 %), the week's days elapsed: 3.5.
        expect(blocksOf(html, "week").map((b) => b.fill)).toEqual([0, 100, 100, 100, 100, 41, 0]);
        expect(blocksOf(html, "week").map((b) => b.reset)).toEqual([false, true, false, false, false, false, false]);
        expect(sharesOf(html, "week")).toEqual(["0", "100", "100", "100", "100", "41", "0"]);
        expect(percentOf(html, "week")).toBe("63 %");
        expect(textOf(html, "week", "usage-week-late")).toMatch(/^[0-9.]+ d (ahead|late)$/);
        expect(rowHtml(html, "week")).not.toContain("usage-week-lost");
    });

    it("hatches the end of a week with a session window whose worth is measured, hatched from the reset day round the week", () => {
        // Friday 12 January, noon: a week that resets Tuesday 16 January 09:00, 3 days 21 hours (93 h) left of the 7.
        const week: UsageWindow = {
            id: "week",
            label: "This week",
            usedpercent: 10,
            resetsat: at(1, 16, 9),
            windowmins: 10080,
            sessionworth: 5,
            sessionmins: 300,
        };
        const info: CompanionUsageInfo = {
            ...claude,
            snapshot: { ...claude.snapshot, windows: [{ ...session, usedpercent: 40 }, week] },
        };
        const html = markup(info, at(1, 12, 12));
        // 93 h is 18.6 sessions worth 93 %, more than the 90 % left: all of it can be used.
        expect(html).not.toContain("usage-week-lost");
        const behind: CompanionUsageInfo = {
            ...info,
            snapshot: {
                ...info.snapshot,
                windows: [
                    { ...session, usedpercent: 40 },
                    { ...week, sessionworth: 2 },
                ],
            },
        };
        const lost = markup(behind, at(1, 12, 12));
        // 18.6 sessions worth 2 % is 37.2 %: 52.8 % of the week cannot be used, 3.7 of its days.
        expect(textOf(lost, "week", "usage-week-lost")).toBe("53 % lost (4 d)");
        // The week resets on a Tuesday: its last days are the ones before the next Tuesday, round the week to Monday.
        const lostBlocks = blocksOf(lost, "week").map((b) => b.lost);
        expect(lostBlocks).toEqual([100, 0, 0, 0, 69.6, 100, 100]);
    });
});

// ---- what must not move ----

describe("what stays as it is (#2473, #2106, #2451, #2458)", () => {
    it("keeps the session ring: only with a session window, round today's letter, in its pace colour, with its use and its reset", () => {
        const html = markup(kimi);
        const ring = ringTag(html);
        expect(ring).toContain('data-testid="usage-week-session"');
        expect(ring).toContain('data-percent="15"');
        expect(ring).toContain('aria-label="Session used: 15 %. Resets in 1 h 20 min (at 13:20)"');
        expect(ring).toContain('data-tip="Session used: 15 %\nResets in 1 h 20 min (at 13:20)"');
        // 15 % of a session that is 3 h 40 min gone is far under its pace: the under-use blue.
        expect(ring).toContain("data-tip-accent-colour=");
        // On today's letter: the third letter, Wednesday.
        expect(html).toMatch(/data-today="true" data-ringed="true"/);
        expect(rowTag(html, "session")).toBe("");
        for (const form of ["minimal", "attached"] as const) {
            expect(ringTag(framed(kimi, form))).toContain('data-percent="15"');
        }
        // No session window, no ring: the month alone, as before.
        const without = kimiAt(now, [monthWindow(HalfADay)]);
        expect(markup(without)).not.toContain("usage-week-session");
        expect(markup(without)).not.toContain("data-ringed");
        // A session window is a ring for a weekly plan too.
        expect(ringTag(markup(claude))).toContain('data-percent="40"');
    });

    it("draws the session ring in the colour of the rows' pace, which the month's days do not move", () => {
        const html = markup(kimi);
        const ring = ringTag(html);
        // The ring's colour is the pace colour of the session's own use and time, as ever.
        const rows = gaugeRows(kimi.snapshot, now);
        const sessionRow = rows.find((r) => r.id === "session");
        expect(ring).toContain(
            `data-tip-accent-colour="${paceColour(sessionRow.line.pace, sessionRow.line.unused).replace(/&/g, "&amp;")}"`
        );
    });

    it("keeps the pace colours and the under-use blue on the month's row, and the blue on its blocks", () => {
        const html = markup(kimi);
        // A month at 1.6 % ten days in: far under what the time allows.
        expect(rowTag(html, "month")).toContain('data-pace="under"');
        const line = gaugeRows(kimi.snapshot, now).find((r) => r.id === "month").line;
        expect(rowTag(html, "month")).toContain(`--mt-uw-pace:${paceColour(line.pace, line.unused)}`);
        // And above its pace: orange, then red, as a week's.
        const above = kimiAt(now, [session, monthWindow(55)]);
        expect(rowTag(markup(above), "month")).toMatch(/data-pace="(above|red)"/);
        const onPace = kimiAt(now, [session, monthWindow(30)]);
        expect(rowTag(markup(onPace), "month")).toContain('data-pace="ok"');
    });

    it("keeps a share under 1 % reading '< 1 %', and the percent of the month rounded as it was", () => {
        const small = kimiAt(now, [session, monthWindow(0.4)]);
        // The markup escapes the sign, as it always did.
        expect(percentOf(markup(small), "month")).toBe("&lt; 1 %");
        expect(percentOf(markup(kimiAt(now, [session, monthWindow(30)])), "month")).toBe("30 %");
        expect(percentOf(markup(kimiAt(now, [session, monthWindow(0)])), "month")).toBe("0 %");
    });

    it("keeps the count to the reset: whole days, hours under a day, in French too", () => {
        const soon = kimiAt(now, [session, monthWindow(30, {}, now + 4 * Hour + 30 * Min)]);
        expect(textOf(markup(soon), "month", "usage-week-chip")).toBe("5 h");
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            // French sets a no-break space between a number and its unit.
            expect(textOf(markup(kimi), "month", "usage-week-chip").replace(/\s/g, " ")).toBe("21 j");
        } finally {
            i18n.setLanguageSetting("");
        }
    });

    it("keeps the weekly grid exactly as it was when no row is monthly: no control column, the same figures line", () => {
        const html = markup(claude);
        expect(html).not.toContain("data-nav");
        expect(html).not.toContain("mt-uw-nav");
        // A figures line of seven cells between two pads, as ever.
        expect(
            /mt-uw-share-pad[^>]*><\/span>(<span class="mt-uw-share"[^>]*>.*?<\/span>){7}<span class="mt-uw-share-pad"/.test(
                html
            )
        ).toBe(true);
        expect([...html.matchAll(/class="mt-uw-share-pad"/g)]).toHaveLength(2);
        // The day letters: seven, with today's mark and the session's ring on it.
        expect([...html.matchAll(/data-testid="usage-week-day"/g)]).toHaveLength(7);
    });

    it("gives a grid with a monthly row no column of controls: every row has the same cells, a pad on each side of its figures", () => {
        const both = kimiAt(now, [
            session,
            { id: "week", label: "This week", usedpercent: 20, resetsat: at(1, 16, 9), windowmins: 10080 },
            monthWindow(30),
        ]);
        const html = markup(both);
        expect(html).not.toContain("data-nav");
        expect(blocksOf(html, "week")).toHaveLength(7);
        expect(rowHtml(html, "week")).not.toContain("usage-week-prev");
        expect([...rowHtml(html, "week").matchAll(/class="mt-uw-share-pad"/g)]).toHaveLength(2);
        expect([...rowHtml(html, "month").matchAll(/class="mt-uw-share-pad"/g)]).toHaveLength(2);
        const css = readFileSync(join(__dirname, "../usage-week/usage-week.css"), "utf8").replace(
            /\/\*[\s\S]*?\*\//g,
            ""
        );
        expect(/\n\.mt-uw \{([^}]*)\}/.exec(css)?.[1]).toContain(
            "var(--mt-uw-first) repeat(7, minmax(var(--mt-uw-block-min), 1fr))"
        );
        expect(css).not.toContain("data-nav");
        expect(css).not.toContain("--mt-uw-nav");
    });

    it("keeps the figures leaving a narrow block, and the cells of their line staying", () => {
        const css = readFileSync(join(__dirname, "../usage-week/usage-week.css"), "utf8").replace(
            /\/\*[\s\S]*?\*\//g,
            ""
        );
        const rule = new RegExp(
            `@container \\(max-width: ${MinFigureBlockPx - 0.02}px\\) \\{\\s*\\.mt-uw-fig \\{([^}]*)\\}`
        ).exec(css);
        expect(rule?.[1]).toContain("display: none");
        const html = markup(kimi);
        expect(html).toContain(
            '<span class="mt-uw-share" aria-hidden="true" data-testid="usage-week-share" data-share="0"><span class="mt-uw-fig">0<span class="mt-uw-unit">%</span></span></span>'
        );
    });

    it("keeps a reading kept for an expired token, with its age, and the month row still drawn", () => {
        const stale = kimiAt(now, [session, monthWindow(HalfADay)], { readat: now - 40 * Min, stale: "tokenexpired" });
        for (const html of [
            markup(stale),
            framed(stale, "full"),
            framed(stale, "minimal"),
            framed(stale, "attached"),
        ]) {
            expect(html).toContain('data-testid="companion-plan-usage-stale"');
            expect(html).toContain("Last reading, updated 40 min ago. It refreshes the next time Kimi Code runs.");
            expect(html).toContain('data-window="month"');
        }
    });
});

// ---- Brokk's grid and its usage tab ----

describe("Brokk's grid (FR-BOSS-009 AC109 and AC110)", () => {
    const readings = (windows: UsageWindow[]): UsageReadings => ({
        kimi: { agent: "kimi", source: "kimi-oauth", readat: now - Min, windows },
    });
    const brokk = (windows: UsageWindow[], initial?: Record<string, number>) => {
        const grid = usageGrid(readings(windows), now);
        return renderToStaticMarkup(
            <UsageWeekGrid
                rows={grid.rows.map((u) => weekRow(u, { show: [], hide: [] }))}
                now={now}
                initialWeeks={initial}
            />
        );
    };

    it("reads a provider whose main window is a month like a week: one calendar week, its controls, its days late", () => {
        const html = brokk([session, monthWindow(HalfADay)]);
        expect(rowTag(html, "month")).toContain('data-monthly="true"');
        expect(rowTag(html, "month")).toContain("9 d late");
        expect(buttonOf(html, "prev")).toContain('aria-label="Previous week"');
        expect(blocksOf(html, "month")).toHaveLength(7);
        // A row led by a logo says its week at the left of the line under it, as a labelled row does (#2565).
        expect(html).toContain('data-testid="usage-week-logo"');
        expect(html).not.toContain('class="mt-uw-label"');
        expect(html).toMatch(/class="mt-uw-weeks" data-testid="usage-week-weeks">Wk 2\/5 · [^<]*8[^<]*14[^<]*</);
        // Brokk draws no session ring: the session window has no row of its own there.
        expect(html).not.toContain("usage-week-session");
    });

    it("hatches the lost days and leaves them out of the days late there as well, and tells nothing unmeasured", () => {
        const lateNow = at(1, 25, 12);
        const grid = usageGrid(
            {
                kimi: {
                    agent: "kimi",
                    source: "kimi-oauth",
                    readat: lateNow - Min,
                    windows: [
                        { ...session, resetsat: lateNow + 2 * Hour },
                        monthWindow(40, { sessionworth: 1.5, sessionmins: 300 }),
                    ],
                },
            },
            lateNow
        );
        const html = renderToStaticMarkup(
            <UsageWeekGrid
                rows={grid.rows.map((u) => weekRow(u, { show: [], hide: [] }))}
                now={lateNow}
                initialWeeks={{ kimi: 4 }}
            />
        );
        expect(textOf(html, "month", "usage-week-late")).toBe("8 d late");
        expect(textOf(html, "month", "usage-week-lost")).toBe("13 % lost (4 d)");
        expect(blocksOf(html, "month").map((b) => b.lost)).toEqual([100, 100, 100, 0, 0, 0, 0]);
    });

    it("leaves the weekly row of a provider as it was, with its logo and its days", () => {
        const html = brokk([
            session,
            { id: "week", label: "This week", usedpercent: 63, resetsat: at(1, 16, 9), windowmins: 10080 },
        ]);
        expect(html).not.toContain("data-nav");
        expect(rowTag(html, "week")).not.toContain("data-monthly");
        expect(blocksOf(html, "week")).toHaveLength(7);
        expect(textOf(html, "week", "usage-week-late")).toMatch(/^[0-9.]+ d (ahead|late)$/);
    });

    it("lists the windows of the usage detail as before, the deduced week gone", () => {
        const rows = gaugeRows(kimiAt(now, [session, monthWindow(30)]).snapshot, now);
        expect(rows.map((r) => r.id)).toEqual(["session", "month"]);
        const month = rows.find((r) => r.id === "month");
        // What the usage tab draws of a row: its label, percent, reset and bar, unchanged by the grid's new words.
        expect(month.label).toBe("This month");
        expect(month.shortLabel).toBe("Month");
        expect(month.percentShort).toBe("30 %");
        expect(month.bar).toBe(30);
        expect(month.resetsShort).toBe("Thu 1 Feb, 00:00");
    });
});
