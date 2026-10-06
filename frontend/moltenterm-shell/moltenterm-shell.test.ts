// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
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

describe("text on the accent (NFR-SHELL-003, #244)", () => {
    const Threshold = 60;
    const Black = { r: 0, g: 0, b: 0 };
    const White = { r: 255, g: 255, b: 255 };
    const rule = /\.bg-accent,\s*((?:\[class\*="bg-accent\/\d+"\],?\s*)+)\{\s*color: var\(--mt-accent-fg\);/.exec(
        shellCss
    );
    const covered = rule == null ? [] : [...rule[1].matchAll(/bg-accent\/(\d+)/g)].map((m) => Number(m[1]));

    // Every `bg-accent/<n>` written in frontend/, Wave's code included: the rule matches class substrings. A
    // `disabled:` fill is left out of the contrast check, as WCAG exempts inactive controls.
    function usedOpacities({ withDisabled }: { withDisabled: boolean }): Set<number> {
        const root = fileURLToPath(new URL("..", import.meta.url));
        const found = new Set<number>();
        for (const file of readdirSync(root, { recursive: true }) as string[]) {
            if (!/\.(tsx?|s?css)$/.test(file) || /\.test\./.test(file)) {
                continue;
            }
            for (const m of readFileSync(join(root, file), "utf8").matchAll(/([\w:-]*)\bbg-accent\/(\d+)\b/g)) {
                if (!withDisabled && m[1].includes("disabled:")) {
                    continue;
                }
                found.add(Number(m[2]));
            }
        }
        return found;
    }

    // The worst case, over the workspace colours and the panel backgrounds, of a text colour on a `pct`% accent tint.
    function worstContrast(pct: number, text: (accent: string) => ReturnType<typeof parseColor>): number {
        let worst = Infinity;
        for (const accent of WorkspaceColours) {
            for (const bg of Backgrounds) {
                const tint = mixColor(parseColor(accent), resolve(bg, accent), pct);
                worst = Math.min(worst, contrastRatio(text(accent), tint));
            }
        }
        return worst;
    }
    const panelText = (accent: string) => resolve("--mt-text-main", accent);
    const accentText = (accent: string) => {
        const a = parseColor(accent);
        return contrastRatio(a, Black) >= contrastRatio(a, White) ? Black : White;
    };

    it("gives the accent's text colour to the solid fill and the near-solid opacities only", () => {
        expect(covered).toEqual([60, 65, 70, 75, 80, 85, 90, 95, 100]);
    });

    it("covers every near-solid opacity used in frontend/", () => {
        const used = usedOpacities({ withDisabled: true });
        expect(used.size).toBeGreaterThan(0);
        for (const pct of used) {
            expect(pct < Threshold || covered.includes(pct), `bg-accent/${pct}`).toBe(true);
        }
    });

    it("keeps the panel's text at 4.5:1 on every tint used in frontend/", () => {
        for (const pct of usedOpacities({ withDisabled: false })) {
            if (pct >= Threshold) {
                continue;
            }
            expect(worstContrast(pct, panelText), `bg-accent/${pct}`).toBeGreaterThanOrEqual(4.5);
        }
    });

    it("switches at the crossover: the accent's text colour reads better from the threshold up, the panel's below", () => {
        for (let pct = Threshold; pct <= 100; pct += 5) {
            expect(worstContrast(pct, accentText), `bg-accent/${pct}`).toBeGreaterThan(worstContrast(pct, panelText));
        }
        for (let pct = 5; pct <= Threshold - 10; pct += 5) {
            expect(worstContrast(pct, panelText), `bg-accent/${pct}`).toBeGreaterThan(worstContrast(pct, accentText));
        }
    });
});
