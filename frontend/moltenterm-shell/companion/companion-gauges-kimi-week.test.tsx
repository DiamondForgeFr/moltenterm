// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Kimi's windows in the companion (#2451): a week deduced from the month drawn like Claude's week, the 5-hour and
// monthly windows as plain gauges, "< 1 %" for a small share, and a kept reading that tells its age.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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
const sharesOf = (html: string, window: string): string[] =>
    [...rowHtml(html, window).matchAll(/<span class="mt-uw-share"[^>]*?(data-unknown="true"|data-share="(\d+)")/g)].map(
        (m) => m[2] ?? "unknown"
    );

describe("plain gauges for the windows the week says nothing of (#2451)", () => {
    it("draws the 5-hour and monthly windows as one bar with the used share and the reset", () => {
        const html = markup(kimi);
        for (const window of ["session", "month"]) {
            expect(rowTag(html, window)).toContain('data-plain="true"');
            expect(blocksOf(html, window)).toEqual([]);
            expect(rowHtml(html, window)).toContain('data-testid="usage-week-gauge"');
            expect(sharesOf(html, window)).toEqual([]);
        }
        expect(rowHtml(html, "session")).toContain(">in 1 h 20 min<");
        expect(rowTag(html, "session")).toContain("Resets in 1 h 20 min");
        expect(rowHtml(html, "month")).toContain(">Tue 1 Dec, 01:00<");
        expect(rowTag(html, "month")).toContain("Resets Tue 1 Dec, 01:00");
        expect(percentOf(html, "month")).toBe("30 %");
        expect(rowHtml(html, "month")).toContain('style="width:30%"');
    });

    it("keeps the plain gauges plain in the minimal and attached forms, with the short reset", () => {
        for (const form of ["minimal", "attached"] as const) {
            const html = framed(kimi, form);
            expect(rowTag(html, "session")).toContain('data-plain="true"');
            expect(rowHtml(html, "session")).toContain(">in 1 h 20 min<");
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
        expect(percentOf(html, "session")).toBe("&lt; 1 %");
        expect(rowTag(html, "session")).toContain('aria-label="Current session, &lt; 1 %');
        const zero = {
            ...kimi,
            snapshot: { ...kimi.snapshot, windows: [{ ...kimi.snapshot.windows[0], usedpercent: 0 }] },
        };
        expect(percentOf(markup(zero), "session")).toBe("0 %");
        const one = {
            ...kimi,
            snapshot: { ...kimi.snapshot, windows: [{ ...kimi.snapshot.windows[0], usedpercent: 1 }] },
        };
        expect(percentOf(markup(one), "session")).toBe("1 %");
    });
});

describe("a week deduced from the month (#2451)", () => {
    it("is drawn like a weekly row: seven days, the ring on Monday, the pace colour, the percent past 100", () => {
        const html = markup(kimi);
        expect(rowTag(html, "week")).toContain('data-deduced="true"');
        expect(html).toContain('data-testid="usage-week-label">Week (from the month)<');
        const blocks = blocksOf(html, "week");
        expect(blocks).toHaveLength(7);
        expect(blocks.map((b) => b.reset)).toEqual([true, false, false, false, false, false, false]);
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
