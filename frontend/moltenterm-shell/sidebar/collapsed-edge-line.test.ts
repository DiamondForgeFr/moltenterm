// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The collapsed sidebar's cue (FR-SHELL-079, #2389): collapsed, only the window's left edge line in the workspace colour;
// peeking, that line alone (the floating sidebar draws none); expanded, the sidebar as it was.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";

const css = fs.readFileSync(path.join(__dirname, "sidebar.css"), "utf8");
const sidebar = fs.readFileSync(path.join(__dirname, "workspace-sidebar.tsx"), "utf8");

function rule(selector: string): string {
    const match = new RegExp(`\\n${selector.replace(/[.()[\]="~-]/g, "\\$&")} \\{([^}]*)\\}`).exec(css);
    expect(match, selector).not.toBeNull();
    return match[1];
}

// What WorkspaceSidebar draws only while the sidebar is hidden.
const hiddenBlock = /\{hidden \? \(\s*<>([\s\S]*?)<\/>\s*\) : null\}/.exec(sidebar)?.[1] ?? "";
// The sidebar's own element, docked or floating.
const aside = sidebar.slice(sidebar.indexOf("<aside"), sidebar.indexOf("</aside>"));

describe("collapsed: the window's left edge line, and nothing else", () => {
    it("draws the place strip at the window's edge while the sidebar is hidden", () => {
        expect(hiddenBlock).toContain(
            '<span className="mt-sb-place-strip mt-sb-edge-line" data-testid="sidebar-edge-line" aria-hidden />'
        );
        expect(hiddenBlock).toContain('className="mt-sb-edge"');
    });

    // #2476 (FR-SHELL-159): the context's ribbon, rolled up to its emblem, is the one mark that comes out of the edge,
    // under the first panel's header; it takes no margin of the content's.
    it("has no rail, no icon: the hidden block holds the left-edge zone, the line and the context's ribbon only", () => {
        expect(hiddenBlock.match(/<(div|span|button|Suspense)\b/g)).toEqual(["<div", "<span", "<div"]);
        expect(hiddenBlock).toContain('<ContextRibbonHost mode="collapsed"');
        expect(hiddenBlock).toContain('className="mt-ribbon-edge"');
        expect(sidebar).not.toMatch(/CollapsedRail|collapsed-rail|collapsed-mark-model/);
        expect(fs.existsSync(path.join(__dirname, "collapsed-rail.tsx"))).toBe(false);
        expect(fs.existsSync(path.join(__dirname, "collapsed-mark-model.ts"))).toBe(false);
        expect(css).not.toMatch(/\.mt-sb-rail|--mt-rail-px/);
    });

    it("gives the content no extra margin: it reaches the window's frame margin as before #2384", () => {
        expect(css).not.toMatch(/~\s*\.mt-frame-content\s*\{[^}]*margin-left/);
        expect(rule(".mt-frame-content")).not.toMatch(/margin-left/);
    });

    it("uses the place strip's own style and colour: the line adds only its stacking", () => {
        const strip = rule(".mt-sb-place-strip");
        expect(strip).toMatch(/left: 0;/);
        expect(strip).toMatch(/top: 0;/);
        expect(strip).toMatch(/bottom: 0;/);
        expect(strip).toMatch(/width: 2px;/);
        expect(strip).toContain("background-color: var(--mt-place);");
        expect(strip).toContain("pointer-events: none;");
        expect(rule(".mt-sb-edge-line").trim()).toMatch(/^z-index: \d+;$/);
    });

    it("follows the workspace colour: the line sets no colour of its own, so each workspace shows its own", () => {
        expect(hiddenBlock).not.toMatch(/style=/);
        expect(rule(".mt-sb-edge-line")).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|--mt-/i);
    });

    it("leaves the rail's text out of both languages", () => {
        expect((en as any).sidebar.collapsedMark).toBeUndefined();
        expect((fr as any).sidebar.collapsedMark).toBeUndefined();
    });
});

describe("peeking: exactly one coloured line", () => {
    it("draws no strip on the floating sidebar", () => {
        expect(rule(".mt-sb.is-hidden .mt-sb-place-strip")).toContain("display: none;");
    });

    it("keeps the window's edge line above the floating sidebar, so Brokk's strip or the slide never hides it", () => {
        const line = Number(/z-index:\s*(\d+)/.exec(rule(".mt-sb-edge-line"))?.[1]);
        const floating = Number(/z-index:\s*(\d+)/.exec(rule(".mt-sb.is-hidden"))?.[1]);
        expect(line).toBeGreaterThan(floating);
    });

    it("draws the line outside the sidebar's element, so the floating sidebar's rules cannot touch it", () => {
        expect(aside).not.toContain("mt-sb-edge-line");
        expect(sidebar.indexOf("sidebar-edge-line")).toBeLessThan(sidebar.indexOf("<aside"));
    });
});

describe("expanded: the sidebar as it was", () => {
    it("keeps the docked sidebar's edge strip and the header's liseré", () => {
        expect(aside).toContain('<span className="mt-sb-place-strip" data-testid="sidebar-place-strip" aria-hidden />');
        expect(sidebar).toContain('<span className="mt-sb-place-bar" data-testid="sidebar-place-bar" aria-hidden />');
    });

    it("hides only the floating sidebar's strip: the docked one keeps its place", () => {
        expect(css).not.toMatch(/\n\.mt-sb:not\(\.is-hidden\) \.mt-sb-place-strip/);
        expect(css.match(/\.mt-sb-place-strip \{/g)).toHaveLength(2);
    });

    it("draws the window's edge line only while the sidebar is hidden", () => {
        expect(sidebar.match(/sidebar-edge-line/g)).toHaveLength(1);
        expect(hiddenBlock).toContain("sidebar-edge-line");
    });
});
