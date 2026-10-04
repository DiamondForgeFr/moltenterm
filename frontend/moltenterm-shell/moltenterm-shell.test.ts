// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { contrastRatio, mixColor, MoltentermDefaultAccent, parseColor } from "./accent";

// Read from disk: vitest stubs stylesheet imports, ?raw included.
const shellCss = readFileSync(new URL("./moltenterm-shell.css", import.meta.url), "utf8");

// Moltenterm's workspace colours (pkg/wcore/workspace.go), Wave's flag colours (frontend/app/tab/tabcontextmenu.ts)
// and a dark blue, the worst case for warm greys.
const WorkspaceColours = [
    MoltentermDefaultAccent,
    "#00FFDB",
    "#429DFF",
    "#BF55EC",
    "#FF453A",
    "#58C142",
    "#FFE900",
    "#FF9500",
    "#1E3A8A",
];

type Recipe = { pct: number; base: string };

// The --mt-neutral-* and --mt-text-* tokens, read from the stylesheet so the test follows any retuning.
function readRecipes(): Record<string, Recipe> {
    const recipes: Record<string, Recipe> = {};
    const re = /(--mt-(?:neutral|text)-[a-z]+):\s*color-mix\(in srgb, var\(--mt-accent\) (\d+)%, (rgb\([^)]*\))\);/g;
    for (const m of shellCss.matchAll(re)) {
        recipes[m[1]] = { pct: Number(m[2]), base: m[3] };
    }
    return recipes;
}

const Recipes = readRecipes();
const Backgrounds = ["--mt-neutral-bg", "--mt-neutral-modal", "--mt-neutral-panel"];
const Texts = ["--mt-text-main", "--mt-text-secondary", "--mt-text-muted"];

function resolve(token: string, accent: string) {
    const recipe = Recipes[token];
    return mixColor(parseColor(accent), parseColor(recipe.base), recipe.pct);
}

describe("warm neutrals (FR-SHELL-014)", () => {
    it("reads every recipe from moltenterm-shell.css", () => {
        for (const token of [...Backgrounds, ...Texts, "--mt-neutral-line", "--mt-neutral-key"]) {
            expect(Recipes[token], token).toBeDefined();
        }
    });

    it("stays a nuance: no neutral takes more than 12% of the accent", () => {
        for (const recipe of Object.values(Recipes)) {
            expect(recipe.pct).toBeGreaterThan(0);
            expect(recipe.pct).toBeLessThanOrEqual(12);
        }
    });

    describe.each(WorkspaceColours)("on workspace colour %s", (accent) => {
        it.each(Texts.flatMap((text) => Backgrounds.map((bg) => [text, bg])))(
            "%s reads at 4.5:1 or more on %s (NFR-SHELL-003)",
            (text, bg) => {
                expect(contrastRatio(resolve(text, accent), resolve(bg, accent))).toBeGreaterThanOrEqual(4.5);
            }
        );

        it("leans towards the accent", () => {
            const warm = resolve("--mt-neutral-bg", accent);
            const grey = parseColor(Recipes["--mt-neutral-bg"].base);
            const a = parseColor(accent);
            const dist = (x: typeof a, y: typeof a) => Math.hypot(x.r - y.r, x.g - y.g, x.b - y.b);
            expect(dist(warm, a)).toBeLessThan(dist(grey, a));
        });
    });

    it("tints the default orange background warm (red over blue)", () => {
        const bg = resolve("--mt-neutral-bg", MoltentermDefaultAccent);
        expect(bg.r).toBeGreaterThan(bg.b);
    });
});

describe("heat states (DS-SHELL-014)", () => {
    it("draws working, waiting and error, and cools done back to neutral", () => {
        for (const state of ["working", "waiting", "error", "done"]) {
            expect(shellCss).toContain(`[data-mt-agent-state="${state}"]::after`);
        }
        expect(shellCss).toMatch(/\[data-mt-agent-state="working"\]::after \{[^}]*animation: mt-heat-breathe/);
        expect(shellCss).toMatch(/\[data-mt-agent-state="waiting"\]::after \{[^}]*--mt-state-waiting/);
        expect(shellCss).toMatch(/\[data-mt-agent-state="done"\]::after \{[^}]*animation: mt-heat-cool[^;]*forwards/);
    });

    it("stops the glow animation under reduced motion", () => {
        expect(shellCss).toMatch(
            /@media \(prefers-reduced-motion: reduce\) \{\s*\.block\.block-frame-default\[data-mt-agent-state\]::after \{\s*animation: none;/
        );
    });

    it("keeps waiting amber distinct from the default accent", () => {
        const amber = parseColor(/--mt-state-waiting: (rgb\([^)]*\))/.exec(shellCss)[1]);
        const orange = parseColor(MoltentermDefaultAccent);
        expect(Math.hypot(amber.r - orange.r, amber.g - orange.g, amber.b - orange.b)).toBeGreaterThan(60);
    });

    it("tells waiting from working by form, not colour alone", () => {
        const rule = (state: string) =>
            new RegExp(`\\[data-mt-agent-state="${state}"\\]::after \\{([^}]*)\\}`).exec(shellCss)[1];
        for (const state of ["waiting", "error"]) {
            expect(rule(state)).toContain("box-shadow: inset 0 0 0 2px var(--mt-heat)");
            expect(rule(state)).toContain("animation: none");
        }
        expect(rule("working")).not.toContain("box-shadow");
        expect(/\[data-mt-agent-state\]::after \{[^}]*box-shadow: inset 0 0 \d+px/.test(shellCss)).toBe(true);
    });
});

describe("interface typeface (FR-SHELL-014)", () => {
    it("uses IBM Plex Sans, with the bundled Inter behind it", () => {
        expect(shellCss).toContain('--mt-ui-font: "IBM Plex Sans", "Inter", sans-serif;');
    });
});
