// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Integration block's pull request status dots sit in the block's corner column, under its agent mark or modified
// ring (FR-SHELL-085, #1304, sidebar.css .mt-sb-corner). A top-row block that clipped its overflow hid what it carries
// (#1283): its glyph is clipped on its own.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = fs.readFileSync(path.join(__dirname, "workspace-sidebar.tsx"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "sidebar.css"), "utf8");

function functionSource(name: string): string {
    const start = src.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    return src.slice(start, src.indexOf("\n}\n", start));
}

function rule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`(^|\\n)${escaped}\\s*{([^}]*)}`));
    expect(match, selector).not.toBeNull();
    return match[2];
}

describe("the sidebar's status dots (#1304)", () => {
    it("stack in one column at the block's right, under the corner mark", () => {
        const corner = rule(".mt-sb-corner");
        expect(corner).toMatch(/position:\s*absolute/);
        expect(corner).toMatch(/right:\s*6px/);
        expect(corner).toMatch(/flex-direction:\s*column/);
        expect(rule(".mt-sb-prdots")).toMatch(/flex-direction:\s*column/);
        const dot = rule(".mt-sb-prdot");
        expect(dot).toMatch(/width:\s*6px/);
        expect(dot).toMatch(/border-radius:\s*9999px/);
    });

    it("colour each state from the theme's state tokens", () => {
        expect(rule(".mt-sb-prdot.is-blocked")).toContain("var(--mt-state-blocked)");
        expect(rule(".mt-sb-prdot.is-ready")).toContain("var(--mt-state-ready)");
        expect(rule(".mt-sb-prdot.is-yours")).toContain("var(--mt-state-waiting)");
        expect(rule(".mt-sb-prdot.is-waiting")).toContain("var(--mt-state-running)");
        expect(rule(".mt-sb-prdot.is-agents")).toContain("var(--mt-state-draft)");
    });

    it("give each section its state's shape, so the five stay apart in greyscale (#1327, FR-SHELL-116)", () => {
        const blocked = rule(".mt-sb-prdot.is-blocked");
        expect(blocked).toMatch(/transform:\s*rotate\(45deg\)/);
        expect(blocked).toMatch(/border-radius:\s*0;/);
        expect(rule(".mt-sb-prdot.is-yours")).toMatch(/box-shadow:\s*0 0 0 1\.5px color-mix/);
        const running = rule(".mt-sb-prdot.is-waiting");
        expect(running).toMatch(/background:\s*transparent/);
        expect(running).toMatch(/border-right-color:\s*color-mix/);
        const agents = rule(".mt-sb-prdot.is-agents");
        expect(agents).toMatch(/background:\s*transparent/);
        expect(agents).toMatch(/border:\s*1\.5px solid currentColor/);
        expect(rule(".mt-sb-prdot.is-ready")).not.toMatch(/background|border|box-shadow/);
        for (const kind of ["yours", "ready", "waiting", "agents"]) {
            expect(rule(`.mt-sb-prdot.is-${kind}`)).not.toMatch(/transform|border-radius/);
        }
    });

    it("never restyle the workspace switcher's own dots (.mt-sb-dots / .mt-sb-dot)", () => {
        const block = css.slice(css.indexOf("/* Pull request status dots"), css.indexOf("/* The top field's results"));
        expect(block).not.toMatch(/\.mt-sb-dots?[\s.,:{]/);
    });

    it("turn the modified pip into a neutral ring with a centre point, never a state's colour (FR-SHELL-116)", () => {
        const pip = rule(".mt-sb-modpip");
        expect(pip).toMatch(/border:\s*1\.5px solid var\(--mt-text-2\)/);
        expect(pip).toMatch(/background:\s*radial-gradient/);
        expect(pip).not.toMatch(/--mt-(state|accent|action)/);
    });

    it("never move under reduced motion", () => {
        const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
        expect(reduced).toMatch(/\.mt-sb-prdots,\s*\n\s*\.mt-sb-prdot\.is-bump/);
    });

    it("live in the corner column of tiles and top-row blocks, the mark first", () => {
        for (const name of ["Tile", "TopRowBlock"]) {
            const block = functionSource(name);
            const corner = block.slice(block.indexOf('className="mt-sb-corner'));
            expect(corner.indexOf("<PrDots")).toBeGreaterThan(corner.indexOf("mt-sb-modpip"));
            expect(corner.indexOf("<PrDots")).toBeGreaterThan(corner.indexOf("AgentMark"));
        }
    });

    it("are not clipped by the top-row block, whose glyph is clipped on its own", () => {
        const block = functionSource("TopRowBlock");
        const button = block.slice(block.indexOf("<button"), block.indexOf("<ViewGlyph"));
        expect(button).not.toMatch(/overflow-hidden/);
        expect(block).toContain(
            '<ViewGlyph icons={glyph} small={glyph.length > 1} className="max-w-full overflow-hidden" />'
        );
    });
});
