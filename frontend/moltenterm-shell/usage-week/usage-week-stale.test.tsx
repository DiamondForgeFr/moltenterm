// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UsageWeekGrid, UsageWeekRow } from "./usage-week";
import { usageWeekLine } from "./usage-week-model";

vi.mock("@/app/store/wos", () => ({ makeORef: (t: string, id: string) => `${t}:${id}` }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));

const Day = 24 * 60 * 60 * 1000;
const now = new Date(2026, 10, 12, 10, 0, 0).getTime();

function row(extra: Partial<UsageWeekRow> = {}): UsageWeekRow {
    const line = usageWeekLine(
        { id: "window:43200", label: "30-day", usedpercent: 100, resetsat: now + 20 * Day, windowmins: 43200 },
        now
    );
    return { key: "codex", agent: "codex", name: "Codex", line, readAt: now - 9 * Day, old: true, ...extra };
}

const html = (rows: UsageWeekRow[]) => renderToStaticMarkup(<UsageWeekGrid rows={rows} now={now} />);
const tag = (markup: string) => /<span class="mt-uw-row"[^>]*>/.exec(markup)?.[0] ?? "";

// FR-BOSS-009, AC96 (#2341): a reading older than its window never looks like a live bar.
describe("a stale row of the week grid", () => {
    it("is marked, and says how old its reading is, in its name and on a line under it", () => {
        const markup = html([row({ stale: true })]);
        expect(tag(markup)).toContain('data-stale="true"');
        expect(tag(markup)).toContain("read 9 d ago");
        expect(/data-testid="usage-week-stale">([^<]*)</.exec(markup)?.[1]).toBe("Read 9 d ago");
    });

    it("is drawn as before when the reading is current", () => {
        const markup = html([row({ old: false, readAt: now - 60000 })]);
        expect(tag(markup)).not.toContain("data-stale");
        expect(markup).not.toContain("usage-week-stale");
    });

    it("tells its age even when the reading is younger than the hour an old reading starts at", () => {
        const markup = html([row({ stale: true, old: false, readAt: now - 40 * 60000 })]);
        expect(tag(markup)).toContain("read 40 min ago");
    });

    it("leaves a line the surface wrote to the surface", () => {
        const markup = html([row({ stale: true, note: "A note" })]);
        expect(markup).toContain('data-testid="usage-week-note"');
        expect(markup).not.toContain("usage-week-stale");
    });

    it("leaves the pace colour, the sheen and the figures' strength to the stylesheet", () => {
        const css = readFileSync(join(__dirname, "usage-week.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        expect(css).toMatch(/\.mt-uw-row\[data-stale="true"\] \.mt-uw-cell i \{[^}]*background: var\(--mt-text-3\)/);
        expect(css).toMatch(/\.mt-uw-row\[data-stale="true"\] \.mt-uw-pct,[^{]*\{[^}]*color: var\(--mt-text-3\)/);
        expect(css).toMatch(/\.mt-uw-row\[data-stale="true"\] \.mt-uw-cell\.is-reset::after \{[^}]*animation: none/);
    });
});
