// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The workspace dot's ring pulse (sidebar.css .mt-sb-dot.has-ring::after) stops under the system's reduced-motion
// setting and under the app's own .prefers-reduced-motion class, the MoltenTerm setting (#1946). It is laid out on the
// dot's own box, never inset by a half pixel from the slot, and breathes by opacity only on the shell's loop (#2265).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(path.join(__dirname, "sidebar.css"), "utf8");

function ruleBody(selector: string): string {
    const start = css.indexOf(`\n${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
}

// Every rule whose selector list names the ring's pseudo-element, whatever its row.
function ringRules(): { selector: string; body: string }[] {
    const rules: { selector: string; body: string }[] = [];
    const re = /(^|\n)([^{}\n][^{}]*?)\{([^{}]*)\}/g;
    for (const m of css.matchAll(re)) {
        const selector = m[2].trim();
        if (selector.includes("has-ring::after") && !selector.includes(":not(.has-ring)")) {
            rules.push({ selector, body: m[3] });
        }
    }
    return rules;
}

describe("workspace dot ring under reduced motion (#1946)", () => {
    it("holds the ring still under the app's .prefers-reduced-motion class", () => {
        expect(css).toMatch(/\.prefers-reduced-motion \.mt-sb-dot\.has-ring::after \{\s*animation: none;\s*\}/);
    });

    it("keeps the system's prefers-reduced-motion media query for the same ring", () => {
        expect(css).toMatch(
            /@media \(prefers-reduced-motion: reduce\) \{\s*\.mt-sb-dot\.has-ring::after \{\s*animation: none;/
        );
    });
});

describe("the ring sits on its dot's centre (#2265)", () => {
    it("is never placed by an inset or an offset from the slot's edges", () => {
        const rules = ringRules();
        expect(rules.length).toBeGreaterThan(0);
        for (const { selector, body } of rules) {
            expect(body, selector).not.toMatch(/(^|[\s;])(inset|right|bottom|margin[-\w]*)\s*:/);
        }
    });

    it("is the dot's own box, laid out on the dot's top left corner as the ripple is", () => {
        const body = ruleBody(".mt-sb-dot.has-ring::after");
        expect(body).toContain("top: calc(50% - var(--mt-sb-ring-dot) * 0.5px);");
        expect(body).toContain("left: calc(50% - var(--mt-sb-ring-dot) * 0.5px);");
        expect(body).toContain("width: calc(var(--mt-sb-ring-dot) * 1px);");
        expect(body).toContain("height: calc(var(--mt-sb-ring-dot) * 1px);");
        expect(body).toContain("outline-offset: var(--mt-sb-ring-gap);");
    });

    it("takes the dot's size in each row, the same as the dot's own rule", () => {
        const dotSize = (selector: string) => Number(/width: (\d+)px/.exec(ruleBody(selector))[1]);
        const ringDot = (selector: string) => Number(/--mt-sb-ring-dot: (\d+);/.exec(ruleBody(selector))[1]);
        expect(ringDot(".mt-sb-dot.has-ring")).toBe(dotSize(".mt-sb-dot > i"));
        expect(ringDot(".mt-sb-dots.is-many .mt-sb-dot.has-ring")).toBe(dotSize(".mt-sb-dots.is-many .mt-sb-dot > i"));
    });

    it("keeps its 18 px and 17 px outer circle, a 1.5 px line", () => {
        const outer = (selector: string) => {
            const body = ruleBody(selector);
            const dot = Number(/--mt-sb-ring-dot: (\d+);/.exec(body)[1]);
            const gap = Number(/--mt-sb-ring-gap: ([\d.]+)px;/.exec(body)[1]);
            return dot + 2 * (gap + 1.5);
        };
        expect(ruleBody(".mt-sb-dot.has-ring::after")).toContain("outline: 1.5px solid var(--mt-sb-dot-colour);");
        expect(outer(".mt-sb-dot.has-ring")).toBe(18);
        expect(outer(".mt-sb-dots.is-many .mt-sb-dot.has-ring")).toBe(17);
    });

    it("breathes by opacity only, on the shell's loop", () => {
        expect(ruleBody(".mt-sb-dot.has-ring::after")).toContain(
            "animation: mt-sb-ring var(--mt-duration-loop) ease-in-out infinite;"
        );
        const start = css.indexOf("\n@keyframes mt-sb-ring {");
        expect(start).toBeGreaterThanOrEqual(0);
        const frames = css.slice(start, css.indexOf("\n}\n", start));
        const props = Array.from(frames.matchAll(/^\s+([a-z-]+):/gm), (m) => m[1]);
        expect(new Set(props)).toEqual(new Set(["opacity"]));
    });
});
