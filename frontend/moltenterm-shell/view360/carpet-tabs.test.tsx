// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it } from "vitest";
import { MoltentermBrowserView } from "../browser/browser-model";
import { I18nModel } from "../i18n/i18n";
import { CarpetStrip, StripHandlers } from "./carpet-tabs";
import { rovingColumnId, stripLayout, stripWidthPx } from "./carpet-tabs-model";
import { buildRadarTicks, radarPitchPx, RadarBlockFacts, RadarColumnInput, RadarTick } from "./radar-model";

const noop = () => {};
const handlers: StripHandlers = {
    go: noop,
    close: noop,
    menu: noop,
    add: noop,
    hover: noop,
    tabPointerDown: noop,
    tabPointerMove: noop,
    tabPointerUp: noop,
    windowEnter: noop,
    windowLeave: noop,
    windowPointerDown: noop,
    windowPointerMove: noop,
    windowPointerUp: noop,
};

// A carpet of count panels, pages and terminals in turn, the first two in view; the third waits for an answer.
function carpet(count: number): RadarTick[] {
    const columns: RadarColumnInput[] = [];
    const facts: Record<string, RadarBlockFacts> = {};
    for (let i = 0; i < count; i++) {
        const page = i % 2 === 0;
        columns.push({ columnId: `c${i}`, leaves: [{ nodeId: `n${i}`, blockId: `b${i}` }] });
        facts[`b${i}`] = {
            view: page ? MoltentermBrowserView : "term",
            agent: false,
            title: page ? `Page ${i}` : `~/project-${i}`,
            attention: i === 2 ? "answer" : null,
            icon: page ? "globe" : "terminal",
        };
    }
    return buildRadarTicks(columns, facts, ["c0", "c1"]);
}

function count(html: string, needle: string): number {
    return html.split(needle).length - 1;
}

// The tabs' opening tags, in order.
function tabTags(html: string): string[] {
    return html.match(/<div role="tab"[^>]*>/g) ?? [];
}

// What the visible area's frame holds.
function frame(html: string): string {
    const start = html.indexOf("mt-radar-window");
    return start === -1 ? "" : html.slice(start, html.indexOf("mt-radar-eye", start));
}

function strip(n: number, availPx: number) {
    const ticks = carpet(n);
    const layout = stripLayout(ticks.length, availPx);
    const html = renderToStaticMarkup(
        <CarpetStrip
            ticks={ticks}
            layout={layout}
            pitch={radarPitchPx(ticks.length, availPx)}
            focusedColumnId="c1"
            rovingColumnId={rovingColumnId(ticks, "c1")}
            pages={{
                b0: { favicon: "data:image/png;base64,AA==", agentName: "" },
                b4: { favicon: null, agentName: "Léon" },
            }}
            drag={null}
            scrubbing={false}
            handlers={handlers}
        />
    );
    return { layout, html };
}

describe("the carpet's tab strip (FR-SHELL-125-AC8, AC12)", () => {
    afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));
    const width = 1180;

    it("shows 1 panel as a titled tab in the visible frame, then the +", () => {
        I18nModel.getInstance().setLanguageSetting("en");
        const { layout, html } = strip(1, width);
        expect(layout.mode).toBe("titles");
        expect(tabTags(html)).toHaveLength(1);
        expect(count(frame(html), 'role="tab"')).toBe(1);
        expect(html).toContain('<span class="mt-strip-title">Page 0</span>');
        expect(html).toMatch(/<img class="mt-strip-glyph" src="data:image\/png/);
        expect(html).toContain('aria-label="Close panel"');
        expect(html).toContain('aria-label="Add a panel at the end of the carpet"');
        expect(html).toContain('role="tablist"');
        expect(stripWidthPx(1, layout)).toBeLessThanOrEqual(width);
    });

    it("shows 5 panels with their titles, marks, roving tab and focus", () => {
        const { layout, html } = strip(5, width);
        expect(layout.mode).toBe("titles");
        const tags = tabTags(html);
        expect(tags).toHaveLength(5);
        expect(count(frame(html), 'role="tab"')).toBe(2);
        expect(tags.map((tag) => tag.match(/tabindex="(-?\d)"/)[1])).toEqual(["-1", "0", "-1", "-1", "-1"]);
        expect(tags[1]).toContain('aria-selected="true"');
        expect(tags[1]).toContain("data-focus");
        expect(tags[2]).toContain('aria-label="Page: Page 2, stored on the carpet, waiting for your answer"');
        expect(count(html, "mt-strip-attention")).toBe(1);
        expect(html).toContain('<span class="mt-strip-agent">L</span>');
        expect(tags[4]).toContain("opened by Léon");
        expect(html).toContain("fa-terminal");
        expect(count(html, 'class="mt-strip-title"')).toBe(5);
        expect(stripWidthPx(5, layout)).toBeLessThanOrEqual(width);
    });

    it("keeps only the icons for 12 panels on a narrow carpet, the title on hover", () => {
        const { layout, html } = strip(12, 640);
        expect(layout.mode).toBe("icons");
        const tags = tabTags(html);
        expect(tags).toHaveLength(12);
        expect(html).not.toContain("mt-strip-title");
        expect(html).not.toContain("mt-strip-close");
        expect(tags[0]).toContain("Page 0");
        expect(stripWidthPx(12, layout)).toBeLessThanOrEqual(640);
    });

    it("falls back to the radar ticks for 40 panels, with the neutral frame and the +", () => {
        const { layout, html } = strip(40, 640);
        expect(layout.mode).toBe("ticks");
        expect(tabTags(html)).toHaveLength(0);
        expect(count(html, 'class="mt-radar-hit')).toBe(40);
        expect(count(frame(html), 'class="mt-radar-hit')).toBe(2);
        expect(html).toContain('data-testid="mt-carpet-add"');
        expect(40 * radarPitchPx(40, 640)).toBeLessThanOrEqual(640);
    });

    it("shows the + alone on an empty carpet", () => {
        const { html } = strip(0, width);
        expect(html).not.toContain("mt-carpet-tabs");
        expect(html).toContain('data-testid="mt-carpet-add"');
    });

    it("speaks French", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const { html } = strip(3, width);
        expect(html).toContain('aria-label="Fermer le panneau"');
        expect(html).toContain('aria-label="Ajouter un panneau au bout du tapis"');
        expect(html).toContain('aria-label="Panneaux sur le tapis"');
    });
});
