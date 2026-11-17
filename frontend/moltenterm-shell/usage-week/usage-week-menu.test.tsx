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

const now = new Date(2026, 10, 12, 10, 0, 0).getTime();

function row(extra: Partial<UsageWeekRow> = {}): UsageWeekRow {
    const line = usageWeekLine({ id: "week", label: "This week", usedpercent: 40, resetsat: now + 86400000 }, now);
    return { key: "codex", agent: "codex", name: "Codex", line, readAt: now, ...extra };
}

const html = (rows: UsageWeekRow[]) => renderToStaticMarkup(<UsageWeekGrid rows={rows} now={now} />);
const rowTag = (markup: string) => /<span class="mt-uw-row"[^>]*>/.exec(markup)?.[0] ?? "";
const logoTag = (markup: string) => /<(?:span|button) [^>]*data-testid="usage-week-logo"[^>]*>/.exec(markup)?.[0] ?? "";

// FR-BOSS-009, AC97 (#2341): the row's choices are reachable from the keyboard, so a row with a menu holds a button.
describe("the logo of a row with a menu is its keyboard button", () => {
    it("is a button that names its menu, in a row that is a group", () => {
        const markup = html([row({ onContextMenu: () => {} })]);
        expect(logoTag(markup)).toMatch(/^<button /);
        expect(logoTag(markup)).toContain('type="button"');
        expect(logoTag(markup)).toContain('aria-haspopup="menu"');
        expect(logoTag(markup)).toContain('aria-label="Show or hide Codex"');
        expect(rowTag(markup)).toContain('role="group"');
        expect(rowTag(markup)).toContain('aria-label="Codex, 40 %');
    });

    it("is the same for a provider that cannot be read", () => {
        const markup = html([row({ line: undefined, unreadable: "expired", onContextMenu: () => {} })]);
        expect(logoTag(markup)).toMatch(/^<button /);
        expect(rowTag(markup)).toContain('role="group"');
    });

    it("stays the plain logo, and the row an image, on a surface with no menu (the companion's grid)", () => {
        const markup = html([row()]);
        expect(logoTag(markup)).toMatch(/^<span /);
        expect(logoTag(markup)).not.toContain("aria-haspopup");
        expect(rowTag(markup)).toContain('role="img"');
    });

    it("is drawn without a box, and rings while the keyboard is on it", () => {
        const css = readFileSync(join(__dirname, "usage-week.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        expect(css).toMatch(/button\.mt-uw-logo \{[^}]*border: 0;[^}]*background: none;[^}]*cursor: pointer;/);
        expect(css).toMatch(/button\.mt-uw-logo:focus-visible \{[^}]*outline: 1px solid var\(--mt-action\)/);
    });
});
