// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The one row shape of the usage grid (#2565, FR-BOSS-009 AC114 to AC116), as the validated mockup draws it
// (https://claude.ai/artifact/JY66xb6Msqk4Lc5Az6zBAz, "Proposition"): every row is its lead, seven day blocks and the
// percent, then one thin line under the blocks and the percent. On its left the line holds the row's context (the
// reset day of a weekly row, the week of a monthly one with its two controls); on its right, the pace. No column of the
// grid is the controls', so the blocks of every row have the same width.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { UsageWindow } from "../companion/companion-gauges-model";
import { I18nModel } from "../i18n/i18n";
import { UsageWeekGrid, UsageWeekRow, WeekControls } from "./usage-week";
import { usageWeekLine, weekCaption, windowWeeks } from "./usage-week-model";

vi.mock("@/app/store/wos", () => ({ makeORef: (t: string, id: string) => `${t}:${id}` }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));

const at = (month: number, day: number, hour = 0, minute = 0, year = 2024) =>
    new Date(year, month - 1, day, hour, minute).getTime();
// Wednesday 10 January 2024, 12:00: a week that resets on Tuesday 16 January, a 31-day month that reset on 1 January.
const now = at(1, 10, 12);

const sessionWindow: UsageWindow = { id: "session", label: "Current session", usedpercent: 15, windowmins: 300 };
const weekWindow = (extra: Partial<UsageWindow> = {}): UsageWindow => ({
    id: "week",
    label: "This week",
    usedpercent: 27,
    resetsat: at(1, 16, 9),
    windowmins: 10080,
    ...extra,
});
const monthWindow: UsageWindow = { id: "month", label: "This month", usedpercent: 2, resetsat: at(2, 1) };

function weeklyRow(extra: Partial<UsageWeekRow> = {}): UsageWeekRow {
    return {
        key: "claude",
        agent: "claude",
        name: "Claude Code",
        window: "week",
        line: usageWeekLine(weekWindow(), now, [sessionWindow]),
        readAt: now,
        ...extra,
    };
}

function monthlyRow(extra: Partial<UsageWeekRow> = {}): UsageWeekRow {
    return {
        key: "kimi",
        agent: "kimi",
        name: "Kimi Code",
        window: "month",
        line: usageWeekLine(monthWindow, now, [sessionWindow]),
        readAt: now,
        ...extra,
    };
}

const html = (rows: UsageWeekRow[], extra: { weeks?: Record<string, number> } = {}) =>
    renderToStaticMarkup(<UsageWeekGrid rows={rows} now={now} initialWeeks={extra.weeks} />);

const rowHtml = (markup: string, provider: string): string => {
    const start = markup.indexOf(`data-provider="${provider}"`);
    const next = markup.indexOf('<span class="mt-uw-row"', start);
    return markup.slice(start, next < 0 ? markup.length : next);
};

// What a row is made of, in order: the lead, the blocks, the percent, the line.
const shapeOf = (row: string): string[] =>
    [...row.matchAll(/data-testid="usage-week-(logo|label|block|percent|line|gauge)"/g)].map((m) => m[1]);
// The line under a row, from its start to the end of the row's markup ("" for a row that has none).
const lineOf = (row: string): string => {
    const start = row.indexOf('<span class="mt-uw-line"');
    return start < 0 ? "" : row.slice(start);
};

const readCss = () => readFileSync(join(__dirname, "usage-week.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (css: string, selector: string): string =>
    new RegExp(`\\n${selector.replace(/[.[\]>*]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";

describe("one row shape for a weekly and a monthly row (AC114)", () => {
    it("is the lead, seven blocks, the percent, then one line, whichever the window", () => {
        const markup = html([weeklyRow(), monthlyRow()]);
        const expected = ["logo", ...Array(7).fill("block"), "percent", "line"];
        expect(shapeOf(rowHtml(markup, "claude"))).toEqual(expected);
        expect(shapeOf(rowHtml(markup, "kimi"))).toEqual(expected);
    });

    it("keeps the same shape for a row led by a label, as the companion draws it", () => {
        const markup = html([
            weeklyRow({ label: "Week", agent: "claude" }),
            monthlyRow({ label: "Consumption", sublabel: "over the month" }),
        ]);
        const expected = ["label", ...Array(7).fill("block"), "percent", "line"];
        expect(shapeOf(rowHtml(markup, "claude"))).toEqual(expected);
        expect(shapeOf(rowHtml(markup, "kimi"))).toEqual(expected);
    });

    it("never stacks the pace under the percent: it is in the line, at its right, after the row's context", () => {
        const markup = html([weeklyRow(), monthlyRow()]);
        for (const provider of ["claude", "kimi"]) {
            const row = rowHtml(markup, provider);
            const percent = row.indexOf('data-testid="usage-week-percent"');
            const line = row.indexOf('data-testid="usage-week-line"');
            const pace = row.indexOf('data-testid="usage-week-pace-note"');
            expect(percent).toBeLessThan(line);
            expect(line).toBeLessThan(row.indexOf('data-testid="usage-week-context"'));
            expect(row.indexOf('data-testid="usage-week-context"')).toBeLessThan(pace);
            // The pace word is inside the line, and no other element holds it.
            expect(lineOf(row)).toContain('data-testid="usage-week-late"');
            expect(row.split('data-testid="usage-week-late"')).toHaveLength(2);
        }
    });

    it("tells the reset day of a weekly row on the left of its line, and its pace on the right", () => {
        const row = rowHtml(html([weeklyRow()]), "claude");
        expect(lineOf(row)).toMatch(
            /^<span class="mt-uw-line" data-testid="usage-week-line"><span class="mt-uw-context" data-testid="usage-week-context">Resets Tuesday<\/span><span class="mt-uw-pace-note" data-testid="usage-week-pace-note">/
        );
        // Claude's week is 3 days in, 27 % used of the 42.8 % the time allows: it is told in days, in the pace's words.
        expect(lineOf(row)).toMatch(/data-testid="usage-week-late">[0-9.]+ d (late|ahead)</);
    });

    it("tells the week of a monthly row on the left of its line, between its two controls, and its pace on the right", () => {
        const row = rowHtml(html([monthlyRow()]), "kimi");
        expect(lineOf(row)).toMatch(
            /^<span class="mt-uw-line" data-testid="usage-week-line"><span class="mt-uw-context" data-testid="usage-week-context"><button [^>]*data-testid="usage-week-prev"[^>]*>.*<\/button><span class="mt-uw-weeks" data-testid="usage-week-weeks">Wk 2\/5 · [^<]*8[^<]*14[^<]*<\/span><button [^>]*data-testid="usage-week-next"[^>]*>.*<\/button><\/span><span class="mt-uw-pace-note"/
        );
        expect(lineOf(row)).toContain('data-testid="usage-week-late">9 d late<');
        // The monthly row has no reset day on its line: its week is its context.
        expect(lineOf(row)).not.toContain("Resets");
    });

    it("says the line in French: the reset day, the short week and the pace", () => {
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            const markup = html([weeklyRow(), monthlyRow()]);
            expect(lineOf(rowHtml(markup, "claude"))).toContain(">Repart mardi<");
            expect(lineOf(rowHtml(markup, "kimi"))).toContain(">Sem. 2/5 · ");
            expect(lineOf(rowHtml(markup, "kimi"))).toContain('data-testid="usage-week-late">9 j de retard<');
        } finally {
            i18n.setLanguageSetting("");
        }
    });

    it("keeps the row's accessible name: its percent, its reset day, its week and its pace", () => {
        const markup = html([weeklyRow(), monthlyRow()]);
        const tags = [...markup.matchAll(/<span class="mt-uw-row"[^>]*>/g)].map((m) => m[0]);
        const claude = tags.find((tag) => tag.includes('data-provider="claude"')) ?? "";
        const kimi = tags.find((tag) => tag.includes('data-provider="kimi"')) ?? "";
        expect(claude).toMatch(/aria-label="Claude Code, 27 %, resets Tuesday, [0-9.]+ d (late|ahead)"/);
        expect(kimi).toMatch(/aria-label="Kimi Code, 2 %, resets Thursday, Week 2 of 5, [^",]*8[^",]*14, 9 d late"/);
        // A weekly row with nothing but text is an image; a monthly one holds buttons, so it is a group.
        expect(claude).toContain('role="img"');
        expect(kimi).toContain('role="group"');
    });

    it("draws the pace in the row's pace colour and the lost share in the error tone, as before", () => {
        const css = readCss();
        expect(rule(css, ".mt-uw-pace-note")).toContain("color: var(--mt-uw-pace, var(--mt-text-3));");
        expect(css).toMatch(/\.mt-uw-lost-text \{[^}]*color-mix\(in srgb, var\(--color-error\) 70%/);
        const lost = usageWeekLine(
            { ...monthWindow, usedpercent: 40, sessionworth: 1.5, sessionmins: 300 },
            at(1, 25, 12),
            [{ ...sessionWindow, resetsat: at(1, 25, 14) }]
        );
        const markup = renderToStaticMarkup(<UsageWeekGrid rows={[monthlyRow({ line: lost })]} now={at(1, 25, 12)} />);
        expect(lineOf(rowHtml(markup, "kimi"))).toContain('data-testid="usage-week-pace-note" data-lost="true"');
        expect(lineOf(rowHtml(markup, "kimi"))).toContain('data-testid="usage-week-lost">13 % lost (4 d)<');
    });

    it("starts the pace with a capital, as the line's sentence, without changing the words the row's name carries", () => {
        const css = readCss();
        expect(rule(css, ".mt-uw-pace-note::first-letter")).toContain("text-transform: uppercase;");
        expect(rule(css, ".mt-uw-pace-note")).toContain("margin-left: auto;");
    });

    it("draws no line for a row with nothing to say there", () => {
        const noReset = weeklyRow({
            line: usageWeekLine({ id: "week", label: "This week", usedpercent: 27, windowmins: 10080 }, now),
        });
        expect(shapeOf(rowHtml(html([noReset]), "claude"))).not.toContain("line");
        // A reading that is stale shows its age under the row, not a reset day or a pace.
        const stale = rowHtml(html([weeklyRow({ stale: true, old: true })]), "claude");
        expect(shapeOf(stale)).not.toContain("line");
        expect(stale).toContain('data-testid="usage-week-stale"');
    });

    it("leaves the reset day to the surface that says the reset time with an icon of its own", () => {
        const row = rowHtml(html([weeklyRow({ label: "Week", reset: "Resets Tue 09:00" })]), "claude");
        expect(row).toContain('data-testid="usage-week-reset"');
        expect(lineOf(row)).not.toContain("Resets");
        expect(lineOf(row)).toContain('data-testid="usage-week-pace-note"');
    });
});

describe("the month's controls are in the line under the row (AC115)", () => {
    const caption = (index: number) => weekCaption(windowWeeks(monthlyRow().line.span), index);

    it("names both controls, small and borderless, with a chevron each", () => {
        const row = rowHtml(html([monthlyRow()]), "kimi");
        const buttons = [...row.matchAll(/<button [^>]*>/g)].map((m) => m[0]);
        expect(buttons).toHaveLength(2);
        expect(buttons[0]).toContain('aria-label="Previous week"');
        expect(buttons[1]).toContain('aria-label="Next week"');
        for (const tag of buttons) {
            expect(tag).toContain('type="button"');
            expect(tag).toContain('class="mt-uw-nav"');
            expect(tag).not.toContain("title=");
        }
        expect(row).toContain("lucide-chevron-left");
        expect(row).toContain("lucide-chevron-right");
        const css = readCss();
        expect(rule(css, ".mt-uw-nav")).toContain("border: 0;");
        expect(rule(css, ".mt-uw-nav")).toContain("background: none;");
        expect(rule(css, ".mt-uw-nav")).toContain("width: 16px;");
        expect(rule(css, ".mt-uw-nav")).toContain("height: 16px;");
        expect(css).toMatch(/\.mt-uw-nav:disabled \{[^}]*opacity: 0\.35;/);
    });

    it("moves the week as before: one step each way, never past the first or the last week", () => {
        const onMove = vi.fn();
        const buttons = (index: number) => {
            const controls = WeekControls({ caption: caption(index), index, count: 5, onMove });
            const [prev, , next] = controls.props.children;
            return { prev: prev.props, next: next.props };
        };
        const middle = buttons(1);
        expect(middle.prev.disabled).toBe(false);
        expect(middle.next.disabled).toBe(false);
        middle.prev.onClick();
        middle.next.onClick();
        expect(onMove.mock.calls).toEqual([[0], [2]]);
        const first = buttons(0);
        const last = buttons(4);
        expect(first.prev.disabled).toBe(true);
        expect(first.next.disabled).toBe(false);
        expect(last.next.disabled).toBe(true);
        expect(last.prev.disabled).toBe(false);
        // A control at an end of the window stays on the end.
        onMove.mockClear();
        first.prev.onClick();
        last.next.onClick();
        expect(onMove.mock.calls).toEqual([[0], [4]]);
    });

    it("shows each week in the line, the end controls off, and the row's week as before", () => {
        const first = rowHtml(html([monthlyRow()], { weeks: { kimi: 0 } }), "kimi");
        expect(first).toContain('data-week="1"');
        expect(lineOf(first)).toMatch(/<button [^>]*disabled=""[^>]*data-testid="usage-week-prev"/);
        expect(lineOf(first)).not.toMatch(/<button [^>]*disabled=""[^>]*data-testid="usage-week-next"/);
        expect(lineOf(first)).toContain(">Wk 1/5 · ");
        const last = rowHtml(html([monthlyRow()], { weeks: { kimi: 4 } }), "kimi");
        expect(last).toContain('data-week="5"');
        expect(lineOf(last)).toMatch(/<button [^>]*disabled=""[^>]*data-testid="usage-week-next"/);
        expect(lineOf(last)).not.toMatch(/<button [^>]*disabled=""[^>]*data-testid="usage-week-prev"/);
        expect(lineOf(last)).toContain(">Wk 5/5 · ");
    });
});

describe("no column of the grid is the controls' (AC115)", () => {
    it("lets a grid with a monthly row keep the columns of a grid without one: every row's blocks are as wide as each other's", () => {
        const withMonth = html([weeklyRow(), monthlyRow()]);
        const withoutMonth = html([weeklyRow()]);
        expect(withMonth).not.toContain("data-nav");
        expect(withoutMonth).not.toContain("data-nav");
        // The header: a spacer, the seven letters, a spacer. Nothing is added on either side for the controls.
        const header = (markup: string) => markup.slice(0, markup.indexOf('<span class="mt-uw-row"'));
        expect(header(withMonth)).toBe(header(withoutMonth));
        expect(header(withMonth).match(/<span aria-hidden="true"><\/span>/g)).toHaveLength(2);
        // The grid's template has the label column, the seven blocks and the percent: nine tracks, whatever the rows.
        const css = readCss();
        const template = rule(css, ".mt-uw");
        expect(template).toContain(
            "var(--mt-uw-first) repeat(7, minmax(var(--mt-uw-block-min), 1fr))\n        minmax(var(--mt-uw-pct-w), max-content);"
        );
        expect(css).not.toContain("data-nav");
        expect(css).not.toContain("--mt-uw-nav");
    });

    it("spans the line over the blocks and the percent, in every form", () => {
        const css = readCss();
        const line = rule(css, ".mt-uw-row > .mt-uw-line");
        expect(line).toContain("grid-column: 2 / -1;");
        expect(line).toContain("display: flex;");
        expect(line).toContain("justify-content: space-between;");
        expect(line).toContain("font-variant-numeric: tabular-nums;");
        expect(rule(css, ".mt-uw-row > .mt-uw-detail")).toContain("grid-column: 2 / -1;");
    });
});

describe("the percent and the air between rows (AC116)", () => {
    it("right-aligns the percent in tabular figures, in one column", () => {
        const css = readCss();
        expect(rule(css, ".mt-uw-pct")).toContain("text-align: right;");
        expect(rule(css, ".mt-uw-pct")).toContain("font-variant-numeric: tabular-nums;");
        expect(rule(css, ".mt-uw")).toContain("--mt-uw-pct-w: 44px;");
    });

    it("keeps a row and its line closer to each other than the rows are to each other", () => {
        const css = readCss();
        expect(rule(css, ".mt-uw")).toContain("--mt-uw-row-gap: var(--mt-space-12);");
        expect(rule(css, ".mt-uw-row > .mt-uw-line")).toContain("margin-top: var(--mt-space-4);");
        expect(rule(css, ".mt-uw-row > *")).toContain("margin-top: var(--mt-uw-row-gap);");
    });
});

describe("what stays as it was", () => {
    it("keeps the reset day's ringed block, the hatched lost days and the stale rows' fade", () => {
        const css = readCss();
        expect(rule(css, ".mt-uw-cell.is-reset")).toContain("outline: 1px solid var(--mt-action);");
        expect(rule(css, ".mt-uw-lost")).toContain("repeating-linear-gradient(");
        expect(css).toMatch(/\.mt-uw-row\[data-stale="true"\] \.mt-uw-cell i \{[^}]*opacity: 0\.45;/);
        const row = rowHtml(html([weeklyRow()]), "claude");
        expect(row).toContain('data-reset="true"');
    });

    it("keeps the logo's name popover and the row's menu on the lead", () => {
        const row = rowHtml(html([weeklyRow({ onContextMenu: () => {} })]), "claude");
        expect(row).toContain('aria-label="Show or hide Claude Code"');
        expect(row).toContain('data-name="Claude Code"');
        expect(row).toContain('aria-haspopup="menu"');
    });

    it("keeps the session ring on a surface that has one, and draws none otherwise", () => {
        const session = {
            percent: 15,
            colour: "var(--mt-info)",
            tip: "tip",
            figure: "15 %",
            name: "Session used: 15 %",
        };
        const withRing = renderToStaticMarkup(<UsageWeekGrid rows={[weeklyRow()]} now={now} session={session} />);
        expect(withRing).toContain('data-testid="usage-week-session"');
        expect(html([weeklyRow()])).not.toContain("usage-week-session");
    });
});
