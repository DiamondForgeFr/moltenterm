// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Kimi's windows in the companion (#2451): a week deduced from the month drawn like Claude's week, the 5-hour and
// monthly windows as plain gauges, "< 1 %" for a small share, and a kept reading that tells its age.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { MinFigureBlockPx } from "../usage-week/usage-week-model";
import { PlanUsageBody, UsageFrame } from "./companion-gauges";
import { CompanionUsageInfo, gaugeRows, gaugesView } from "./companion-gauges-model";

vi.mock("@/app/store/wos", () => ({ makeORef: (t: string, id: string) => `${t}:${id}` }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));

const Min = 60 * 1000;
const Hour = 60 * Min;
// Thursday 19 November 2026, 12:00 local.
const now = new Date(2026, 10, 19, 12, 0, 0).getTime();
const monday = new Date(2026, 10, 23, 0, 0, 0).getTime();

// What wavesrv sends for Kimi's managed kimi.ai usage: a 5-hour window, the deduced week, the month (pkg/molten/usage).
const kimi: CompanionUsageInfo = {
    blockid: "k1",
    agent: "kimi",
    pageurl: "https://www.kimi.ai/code/console",
    pagename: "Kimi usage",
    hasgauges: true,
    gauges: "enabled",
    sourcename: "Kimi Code managed usage endpoint",
    snapshot: {
        agent: "kimi",
        source: "kimi-oauth",
        readat: now - 2 * Min,
        windows: [
            {
                id: "session",
                label: "Current session",
                usedpercent: 0.15,
                resetsat: now + Hour + 20 * Min,
                windowmins: 300,
            },
            {
                id: "week",
                label: "Week (from the month)",
                usedpercent: 128.6,
                resetsat: monday,
                windowmins: 10080,
                deduced: true,
                days: [-1, -1, 240, 150, 0, 0, 0],
            },
            { id: "month", label: "This month", usedpercent: 30, resetsat: new Date(2026, 11, 1, 1, 0).getTime() },
        ],
    },
};

// What wavesrv sends for Claude Code: its own weekly window and session.
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
            {
                id: "week",
                label: "This week",
                usedpercent: 63,
                resetsat: new Date(2026, 10, 24, 9, 0).getTime(),
                windowmins: 10080,
            },
            {
                id: "model:fable",
                label: "This week (Fable)",
                usedpercent: 12,
                resetsat: new Date(2026, 10, 24, 9, 0).getTime(),
                windowmins: 10080,
            },
        ],
    },
};

const noop = { onShow: () => {}, onHide: () => {}, onRefresh: () => {} };

function markup(info: CompanionUsageInfo): string {
    return renderToStaticMarkup(<PlanUsageBody view={gaugesView(info, now)} {...noop} />);
}

const frame: UsageFrame = ({ tools, body }) => (
    <div>
        {tools}
        {body}
    </div>
);

function framed(info: CompanionUsageInfo, form: "full" | "minimal" | "attached"): string {
    return renderToStaticMarkup(<PlanUsageBody view={gaugesView(info, now)} {...noop} frame={frame} form={form} />);
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
const blocksOf = (html: string, window: string) =>
    [...rowHtml(html, window).matchAll(/<span class="mt-uw-cell([^"]*)"[^>]*><i style="width:([0-9.]+)%"/g)].map(
        (m) => ({
            fill: Number(m[2]),
            reset: m[1].includes("is-reset"),
            unknown: m[1].includes("is-unknown"),
        })
    );
const percentOf = (html: string, window: string): string =>
    /data-testid="usage-week-percent">([^<]*)</.exec(rowHtml(html, window))?.[1] ?? "";
// The words of a row's reset icon (#2458).
const resetOf = (html: string, window: string): string =>
    /<span class="mt-uw-reset"[^>]*aria-label="([^"]*)"/.exec(rowHtml(html, window))?.[1] ?? "";
const sharesOf = (html: string, window: string): string[] =>
    [...rowHtml(html, window).matchAll(/<span class="mt-uw-share"[^>]*?(data-unknown="true"|data-share="(\d+)")/g)].map(
        (m) => m[2] ?? "unknown"
    );

// The session's ring round today's letter (#2473): its opening tag, empty when there is none.
const ringTag = (html: string): string => /<span class="mt-uw-ring"[^>]*>/.exec(html)?.[0] ?? "";

describe("plain gauges for the windows the week says nothing of (#2451)", () => {
    it("draws the monthly window as one bar with the used share and the reset, and the 5-hour session as a ring (#2473)", () => {
        const html = markup(kimi);
        expect(rowTag(html, "month")).toContain('data-plain="true"');
        expect(blocksOf(html, "month")).toEqual([]);
        expect(rowHtml(html, "month")).toContain('data-testid="usage-week-gauge"');
        expect(sharesOf(html, "month")).toEqual([]);
        expect(rowTag(html, "session")).toBe("");
        expect(ringTag(html)).toContain("Resets in 1 h 20 min (at 13:20)");
        expect(rowHtml(html, "month")).toContain(">Tue 1 Dec, 01:00<");
        expect(rowTag(html, "month")).toContain("Resets Tue 1 Dec, 01:00");
        expect(percentOf(html, "month")).toBe("30 %");
        expect(rowHtml(html, "month")).toContain('style="width:30%"');
    });

    it("keeps the month plain and the session a ring in the minimal and attached forms (#2473)", () => {
        for (const form of ["minimal", "attached"] as const) {
            const html = framed(kimi, form);
            expect(rowTag(html, "session")).toBe("");
            expect(ringTag(html)).toContain('data-testid="usage-week-session"');
            expect(rowTag(html, "month")).toContain('data-plain="true"');
            expect(rowTag(html, "week")).not.toContain("data-plain");
        }
    });

    it("leaves Claude's weekly windows on the day grid, unchanged", () => {
        const html = markup(claude);
        for (const window of ["week", "model:fable"]) {
            expect(rowTag(html, window)).not.toContain("data-plain");
            expect(blocksOf(html, window)).toHaveLength(7);
        }
        // 63 % from a Tuesday reset: Tuesday to Friday full, Saturday 41 %.
        expect(blocksOf(html, "week").map((b) => b.fill)).toEqual([0, 100, 100, 100, 100, 41, 0]);
        expect(blocksOf(html, "week").map((b) => b.reset)).toEqual([false, true, false, false, false, false, false]);
        expect(sharesOf(html, "week")).toEqual(["0", "100", "100", "100", "100", "41", "0"]);
        expect(percentOf(html, "week")).toBe("63 %");
        expect(html).not.toContain("usage-week-gauge");
    });
});

describe("a share under 1 % (#2451)", () => {
    it("shows 0.15 % as < 1 %, never 0 %", () => {
        const html = markup(kimi);
        expect(ringTag(html)).toContain('aria-label="Session used: &lt; 1 %. Resets in 1 h 20 min (at 13:20)"');
        const zero = {
            ...kimi,
            snapshot: { ...kimi.snapshot, windows: [{ ...kimi.snapshot.windows[0], usedpercent: 0 }] },
        };
        expect(ringTag(markup(zero))).toContain('data-tip="Session used: 0 %\n');
        const one = {
            ...kimi,
            snapshot: { ...kimi.snapshot, windows: [{ ...kimi.snapshot.windows[0], usedpercent: 1 }] },
        };
        expect(ringTag(markup(one))).toContain('data-tip="Session used: 1 %\n');
    });
});

describe("a week deduced from the month (#2451)", () => {
    it("is drawn like a weekly row: seven days, the pace colour, the percent past 100, no ring outside the reset's week", () => {
        const html = markup(kimi);
        expect(rowTag(html, "week")).toContain('data-deduced="true"');
        // Two lines in the narrow label column: "Consumption", and a small dimmed "from the month" under it (#2473).
        expect(html).toContain(
            'data-testid="usage-week-label">Consumption<span class="mt-uw-label-sub" data-testid="usage-week-sublabel">from the month</span>'
        );
        expect(rowTag(html, "week")).toContain('aria-label="Week (from the month), 129 %');
        const blocks = blocksOf(html, "week");
        expect(blocks).toHaveLength(7);
        // Monday only starts the calculation; the month resets on Tuesday 1 December, in a later week.
        expect(blocks.map((b) => b.reset)).toEqual([false, false, false, false, false, false, false]);
        expect(blocks.map((b) => b.fill)).toEqual([0, 0, 100, 100, 0, 0, 0]);
        expect(percentOf(html, "week")).toBe("129 %");
        expect(rowTag(html, "week")).toMatch(/data-pace="(above|red)"/);
    });

    it("leaves the days before recording unknown: dimmed, empty, no figure, never 0 %", () => {
        const html = markup(kimi);
        expect(blocksOf(html, "week").map((b) => b.unknown)).toEqual([true, true, false, false, false, false, false]);
        expect(sharesOf(html, "week")).toEqual(["unknown", "unknown", "240", "150", "0", "0", "0"]);
        const minimal = framed(kimi, "minimal");
        expect(rowTag(minimal, "week")).toMatch(/aria-label="[^"]*per day: Mon unknown, Tue unknown, Wed 240 %/);
    });

    it("explains its calculation in its tooltip, in the full and minimal forms", () => {
        const [, week] = gaugeRows(kimi.snapshot, now);
        expect(week.explain).toContain("monthly limit × 7");
        for (const html of [markup(kimi), framed(kimi, "minimal"), framed(kimi, "attached")]) {
            expect(rowTag(html, "week")).toContain("monthly limit × 7");
            expect(rowTag(html, "session")).not.toContain("monthly limit");
        }
    });
});

describe("a reading kept while the token has expired (#2451)", () => {
    const stale: CompanionUsageInfo = {
        ...kimi,
        snapshot: { ...kimi.snapshot, readat: now - 40 * Min, stale: "tokenexpired" },
    };

    it("shows the last reading with its age and when it refreshes, in every form", () => {
        for (const html of [
            markup(stale),
            framed(stale, "full"),
            framed(stale, "minimal"),
            framed(stale, "attached"),
        ]) {
            expect(html).toContain('data-testid="companion-plan-usage-stale"');
            expect(html).toContain("Last reading, updated 40 min ago. It refreshes the next time Kimi Code runs.");
            expect(html).toContain('data-window="month"');
            expect(html).not.toContain('data-state="unavailable"');
        }
    });

    it("says nothing of the kind for a fresh reading", () => {
        expect(markup(kimi)).not.toContain("companion-plan-usage-stale");
        expect(framed(kimi, "minimal")).not.toContain("companion-plan-usage-stale");
    });
});

// The same reading with the month resetting at `resetsAt`, for any agent (the rule is the window's, not the provider's).
function withMonthReset(resetsAt: number, agent = "kimi"): CompanionUsageInfo {
    return {
        ...kimi,
        agent,
        snapshot: {
            ...kimi.snapshot,
            agent,
            windows: kimi.snapshot.windows.map((w) => (w.id === "month" ? { ...w, resetsat: resetsAt } : w)),
        },
    };
}

describe("the monthly reset on the deduced week (#2451)", () => {
    // Saturday 21 November 2026, 01:00: inside the week of Thursday 19 November.
    const saturday = new Date(2026, 10, 21, 1, 0).getTime();

    it("rings only the day the month resets, and only in the week that holds it", () => {
        const ring = (info: CompanionUsageInfo) => blocksOf(markup(info), "week").map((b) => b.reset);
        expect(ring(withMonthReset(saturday))).toEqual([false, false, false, false, false, true, false]);
        expect(ring(kimi)).toEqual(Array(7).fill(false));
        // Next week's Monday is outside this week.
        expect(ring(withMonthReset(new Date(2026, 10, 23, 1, 0).getTime()))).toEqual(Array(7).fill(false));
        // Keyed on the window, not on the provider: another agent's deduced week follows the same rule.
        expect(ring(withMonthReset(saturday, "someagent"))).toEqual([false, false, false, false, false, true, false]);
        // A weekly window keeps its ring every week, on its own reset day.
        expect(blocksOf(markup(claude), "week").map((b) => b.reset)).toEqual([
            false,
            true,
            false,
            false,
            false,
            false,
            false,
        ]);
    });

    it("tells the month's reset with the row's reset icon, never Monday's (#2458)", () => {
        const html = markup(withMonthReset(saturday));
        expect(resetOf(html, "week")).toBe("Resets Sat 01:00");
        expect(resetOf(markup(kimi), "week")).toBe("Resets Tue 1 Dec, 01:00");
        expect(rowHtml(markup(kimi), "week")).not.toContain("Mon 00:00");
        // No line of words is left under the row.
        expect(markup(kimi)).not.toContain("usage-week-note");
    });

    it("keeps the count to the monthly reset beside the reset icon, in every form (#2458)", () => {
        for (const html of [markup(kimi), framed(kimi, "full"), framed(kimi, "minimal"), framed(kimi, "attached")]) {
            const week = rowHtml(html, "week");
            expect(resetOf(html, "week")).toBe("Resets Tue 1 Dec, 01:00");
            expect(week).toContain('data-testid="usage-week-chip"');
            // The icon, then the count, then the percent.
            expect(week.indexOf("usage-week-reset")).toBeLessThan(week.indexOf("usage-week-chip"));
            expect(week.indexOf("usage-week-chip")).toBeLessThan(week.indexOf("usage-week-percent"));
            // The 5-hour window and the month are plain gauges and keep no icon.
            expect(rowHtml(html, "session")).not.toContain("usage-week-reset");
            expect(rowHtml(html, "month")).not.toContain("usage-week-reset");
        }
    });

    it("counts the days to the reset, and the hours under a day", () => {
        const html = markup(kimi);
        // 11 days and 13 hours to Tuesday 1 December, 01:00.
        expect(/data-testid="usage-week-chip">([^<]*)</.exec(rowHtml(html, "week"))?.[1]).toBe("11 d");
        expect(rowHtml(html, "week")).toContain('data-tip="Monthly reset in 11 days, Tue 1 Dec, 01:00"');
        const soon = markup(withMonthReset(now + 4 * Hour + 30 * Min));
        expect(/data-testid="usage-week-chip">([^<]*)</.exec(rowHtml(soon, "week"))?.[1]).toBe("5 h");
        expect(rowHtml(soon, "week")).toMatch(/data-tip="Monthly reset in 5 h, Thu 19 Nov, 16:30"/);
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            expect(/data-testid="usage-week-chip">([^<]*)</.exec(rowHtml(markup(kimi), "week"))?.[1]).toBe("11 j");
        } finally {
            i18n.setLanguageSetting("");
        }
    });

    it("shows the count in the full, minimal and attached forms, and on no other row", () => {
        for (const html of [markup(kimi), framed(kimi, "full"), framed(kimi, "minimal"), framed(kimi, "attached")]) {
            expect(rowHtml(html, "week")).toContain('data-testid="usage-week-chip"');
            expect(rowHtml(html, "month")).not.toContain("usage-week-chip");
            expect(rowTag(html, "week")).toContain("Monthly reset in 11 days");
        }
        expect(markup(claude)).not.toContain("usage-week-chip");
    });

    it("leaves the month's reset to the count in the forms without a reset line, keeping it in its tooltip", () => {
        for (const form of ["minimal", "attached"] as const) {
            const html = framed(kimi, form);
            expect(rowHtml(html, "month")).not.toContain("usage-week-gauge-reset");
            expect(rowTag(html, "month")).toContain("Resets Tue 1 Dec, 01:00");
        }
        expect(rowHtml(markup(kimi), "month")).toContain(">Tue 1 Dec, 01:00<");
    });
});

describe("the day figures in a narrow grid (#2451)", () => {
    const css = readFileSync(join(__dirname, "../usage-week/usage-week.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

    it("hides a figure when its own block is too narrow to hold it, whatever the label column takes (#2458)", () => {
        // The query is on the block's own width: a container per cell of the figures' line.
        const rule = new RegExp(
            `@container \\(max-width: ${MinFigureBlockPx - 0.02}px\\) \\{\\s*\\.mt-uw-fig \\{([^}]*)\\}`
        ).exec(css);
        expect(rule?.[1]).toContain("display: none");
        expect(css).not.toMatch(/@container \(max-width: 3\d\d(\.\d+)?px\)/);
        expect(css).not.toContain("DayFiguresMinGridPx");
    });

    it("keeps the pads and the cells of the figures' line when the figures leave, so the rows below keep their columns", () => {
        const html = markup(kimi);
        const line =
            /<span class="mt-uw-share-pad"[^>]*><\/span>(<span class="mt-uw-share"[^>]*>.*?<\/span>){7}<span class="mt-uw-share-pad"/.exec(
                html
            );
        expect(line).not.toBeNull();
        // The figure is the cell's inner span, the one the query hides: the cell itself stays, empty.
        expect(html).toContain(
            '<span class="mt-uw-share" aria-hidden="true" data-testid="usage-week-share" data-share="240"><span class="mt-uw-fig">240<span class="mt-uw-unit">%</span></span></span>'
        );
    });

    it("keeps the figures in the row's tooltip in the full form", () => {
        expect(rowTag(markup(claude), "week")).toMatch(/data-tip="[^"]*Per day: Mon 0 %, Tue 100 %/);
        expect(rowTag(markup(kimi), "week")).toMatch(/data-tip="[^"]*Per day: Mon unknown, Tue unknown, Wed 240 %/);
    });

    it("labels the deduced week in French on two lines", () => {
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            expect(markup(kimi)).toContain(
                'data-testid="usage-week-label">Consommation<span class="mt-uw-label-sub" data-testid="usage-week-sublabel">d&#x27;après le mois</span>'
            );
        } finally {
            i18n.setLanguageSetting("");
        }
    });
});
