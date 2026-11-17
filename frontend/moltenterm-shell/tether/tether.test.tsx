// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tether } from "./tether";
import { tetherLine } from "./tether-model";

const css = readFileSync(join(__dirname, "tether.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = readFileSync(join(__dirname, "..", "tokens.css"), "utf8");

function rule(selector: string, sheet = css): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\n${escaped} \\{([^}]*)\\}`).exec(sheet)?.[1] ?? "";
}

function render(open: boolean): string {
    return renderToStaticMarkup(
        <Tether line={tetherLine(100, 122, 40, 16)} open={open} className="mt-test-link" testId="a-tether" />
    );
}

describe("the tether (FR-BOSS-009, AC65, #2196)", () => {
    it("is one rope with an anchor and a knot, hidden from assistive technology", () => {
        const html = render(true);
        expect(html).toContain('class="mt-tether-rope"');
        expect(html).toContain('class="mt-tether-anchor"');
        expect(html).toContain('class="mt-tether-knot"');
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain('data-testid="a-tether"');
        expect(html).toContain("mt-test-link");
    });

    it("is placed from its line and tells the style sheet how long it is and how much of it is out at first", () => {
        const html = render(true);
        expect(html).toContain("left:100px;top:39px;width:22px");
        expect(html).toContain("--mt-tether-w:22px");
        expect(html).toContain("--mt-tether-from:0.2727");
    });

    it("is in with what it holds and out without it", () => {
        expect(render(true)).toMatch(/class="mt-tether is-in mt-test-link"/);
        expect(render(true)).toContain('data-open="true"');
        expect(render(false)).toMatch(/class="mt-tether mt-test-link"/);
        expect(render(false)).toContain('data-open="false"');
    });
});

describe("the style of the tether (AC65 to AC69)", () => {
    it("is a continuous ember line: no dashes, no dots, no pattern", () => {
        expect(css).not.toMatch(/dashed|dotted|dasharray|repeating-|border-style|background-image/);
        const rope = rule(".mt-tether-rope");
        expect(rope).toMatch(/height: 2px;/);
        expect(rope).toMatch(/width: 100%;/);
        expect(rope).toMatch(/background: var\(--mt-action\);/);
    });

    it("is tied at both ends: an anchor of 6 px at the start and a knot of 4 px at the far end", () => {
        const anchor = rule(".mt-tether-anchor");
        expect(anchor).toMatch(/width: 6px;/);
        expect(anchor).toMatch(/border-radius: 50%;/);
        expect(anchor).toMatch(/left: -3px;/);
        const knot = rule(".mt-tether-knot");
        expect(knot).toMatch(/width: 4px;/);
        expect(knot).toMatch(/transform: translateX\(calc\(var\(--mt-tether-w\) \* var\(--mt-tether-from, 0\)\)\);/);
        expect(rule(".mt-tether.is-in .mt-tether-knot")).toMatch(/transform: translateX\(var\(--mt-tether-w\)\);/);
    });

    it("grows from its anchor: scaled from the start, from what is out at first to whole", () => {
        const rope = rule(".mt-tether-rope");
        expect(rope).toMatch(/transform-origin: 0 50%;/);
        expect(rope).toMatch(/transform: scaleX\(var\(--mt-tether-from, 0\)\);/);
        expect(rule(".mt-tether.is-in .mt-tether-rope,\n.mt-tether.is-in .mt-tether-anchor")).toMatch(
            /transform: none;/
        );
    });

    it("plays the one time and curve of what it holds on its rope, its anchor and its knot, and follows the button", () => {
        for (const part of [".mt-tether-rope", ".mt-tether-anchor", ".mt-tether-knot"]) {
            expect(rule(part), part).toMatch(/transition: transform var\(--mt-tether-time\) var\(--mt-tether-ease\);/);
        }
        const root = rule(".mt-tether.mt-tether");
        expect(root).toMatch(/opacity var\(--mt-tether-fade\) linear,/);
        expect(root).toMatch(/top var\(--mt-tether-time\) var\(--mt-ease\);/);
        expect(rule(".mt-tether")).toMatch(/--mt-tether-time: var\(--mt-duration-settle\);/);
    });

    it("settles once: the curve goes past its end once and comes back, and it is a transition, never an animation", () => {
        const token = /--mt-ease-tether: cubic-bezier\(([\d., ]+)\);/.exec(tokens)?.[1];
        expect(token).toBeDefined();
        const [x1, y1, , y2] = token.split(",").map(Number);
        expect(y2).toBe(1);
        expect(y1).toBeGreaterThan(1);
        const bezier = (t: number) => 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3;
        const samples = Array.from({ length: 101 }, (_, i) => bezier(i / 100));
        const peak = Math.max(...samples);
        // About 8 % past the end: a give of about 1 px on a slide of 16 px.
        expect(peak).toBeGreaterThan(1.05);
        expect(peak).toBeLessThan(1.12);
        const crossings = samples.slice(1).filter((v, i) => (v - 1) * (samples[i] - 1) < 0).length;
        expect(crossings).toBe(1);
        expect(x1).toBeGreaterThan(0);
        expect(css).not.toMatch(/@keyframes|animation:/);
    });

    it("mounts in step with its panel: it starts from the closed pose when it appears already in", () => {
        const starting = /@starting-style \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
        expect(starting).toMatch(/\.mt-tether\.is-in \{\s*opacity: 0;/);
        expect(starting).toMatch(
            /\.mt-tether\.is-in \.mt-tether-rope \{\s*transform: scaleX\(var\(--mt-tether-from, 0\)\);/
        );
        expect(starting).toMatch(/\.mt-tether\.is-in \.mt-tether-anchor \{\s*transform: scale\(0\);/);
    });

    it("takes no pointer, even in a group whose children all do", () => {
        expect(rule(".mt-tether.mt-tether")).toMatch(/pointer-events: none;/);
    });

    it("grows nothing under reduced motion, in both ways the app tells it: full length, the group's short fade", () => {
        const media = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}\n/.exec(css)?.[1] ?? "";
        const app = css.slice(css.indexOf(".prefers-reduced-motion .mt-tether.mt-tether"));
        for (const [scope, prefix] of [
            [media, ""],
            [app, ".prefers-reduced-motion "],
        ] as const) {
            expect(scope, prefix).toMatch(
                new RegExp(
                    `${prefix.replace(".", "\\.")}\\.mt-tether\\.mt-tether \\{\\s*transition: opacity var\\(--mt-duration-fade\\) linear !important;`
                )
            );
            expect(scope, prefix).toMatch(
                /\.mt-tether-anchor \{\s*transform: none !important;\s*transition: none !important;/
            );
            expect(scope, prefix).toMatch(
                /\.mt-tether-knot \{\s*transform: translateX\(var\(--mt-tether-w\)\) !important;\s*transition: none !important;/
            );
        }
    });

    it("touches nothing but itself: Brokk's portrait, the rail and the square keep their own motion", () => {
        const selectors = [...css.matchAll(/(^|\n|\{)\s*([^{}@]+?)\s*\{/g)].flatMap((m) => m[2].split(","));
        expect(selectors.length).toBeGreaterThan(5);
        for (const selector of selectors) {
            expect(selector.trim(), selector).toMatch(/^(\.prefers-reduced-motion )?\.mt-tether/);
        }
        expect(css).not.toMatch(/animation-play-state|visibility|display:\s*none|video|canvas|portrait|brokk/);
    });
});
