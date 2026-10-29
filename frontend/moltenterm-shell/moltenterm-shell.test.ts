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

// The action tokens (#1319): fixed, the same in every workspace.
function shellToken(name: string): ReturnType<typeof parseColor> {
    return parseColor(new RegExp(`${name}: (#[0-9a-f]{6});`).exec(shellCss)?.[1]);
}
const Action = shellToken("--mt-action");
const ActionFg = shellToken("--mt-action-fg");

// The --mt-neutral-* and --mt-text-* tokens, read from the stylesheet so the test follows any retuning.
function readRecipes(): Record<string, Recipe> {
    const recipes: Record<string, Recipe> = {};
    const re = /(--mt-(?:neutral|text)-[a-z]+):\s*color-mix\(in srgb, var\(--mt-place\) (\d+)%, (rgb\([^)]*\))\);/g;
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

        // Step 2 of the Coulée theme (#1318) replaces these tints with fixed neutrals.
        it("leans towards the workspace colour", () => {
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
        const working = /\[data-mt-agent-state="working"\]::after \{([^}]*)\}/.exec(shellCss)[1];
        expect(working).toContain("--mt-state-working");
        // #473: a static glow; the header segment carries the motion on the shared beat.
        expect(working).not.toContain("animation");
        expect(shellCss).not.toContain("mt-heat-breathe");
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
    const Threshold = 70;
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

    // The worst case, over the workspace colours (the panels still take their tint, #1318 step 2) and the panel
    // backgrounds, of a text colour on a `pct`% tint of the accent, which is the fixed action colour (#1319).
    function worstContrast(pct: number, text: (place: string) => ReturnType<typeof parseColor>): number {
        let worst = Infinity;
        for (const place of WorkspaceColours) {
            for (const bg of Backgrounds) {
                const tint = mixColor(Action, resolve(bg, place), pct);
                worst = Math.min(worst, contrastRatio(text(place), tint));
            }
        }
        return worst;
    }
    const panelText = (place: string) => resolve("--mt-text-main", place);
    const accentText = () => ActionFg;

    it("draws the accent's text in the action's fixed text colour", () => {
        expect(shellCss).toMatch(/:root \{[^}]*--mt-accent-fg: var\(--mt-action-fg\);/);
        expect([Black, White]).not.toContainEqual(ActionFg);
    });

    it("gives the accent's text colour to the solid fill and the near-solid opacities only", () => {
        expect(covered).toEqual([70, 75, 80, 85, 90, 95, 100]);
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

// Every file the Project overview and CI/CD draw a running indicator from.
const IndicatorSources = [
    "mission/action-button.tsx",
    "mission/branch-cleanup.tsx",
    "mission/build-local-menu.tsx",
    "mission/ci-local-panel.tsx",
    "mission/cicd-panels.tsx",
    "mission/line-map.tsx",
    "mission/mission-frame.tsx",
    "mission/release-menu.tsx",
    "mission/release-run-panel.tsx",
    "mission/release-state-panel.tsx",
    "mission/runs-view.tsx",
    "project/next-station-header.tsx",
    "project/overview-cards.tsx",
    "status-bar-model.ts",
];

describe("running indicators (NFR-MC-004)", () => {
    it.each(IndicatorSources)("%s moves only in steps", (file) => {
        const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
        expect(source).not.toMatch(/\banimate-(ping|pulse|spin|bounce)\b/);
        expect(source.match(/\bfa-spin\b(?! mt-step-spin)/g)).toBeNull();
    });

    it("steps every indicator on the line map's 0.25 s grid", () => {
        expect(shellCss).toMatch(/\.mt-step-blink \{\s*animation: mt-step-blink 1\.5s step-end infinite;/);
        expect(shellCss).toMatch(/\.mt-step-ping \{\s*animation: mt-step-ping 1\.5s step-end infinite;/);
        expect(shellCss).toMatch(
            /\.mt-step-spin \{\s*--fa-animation-duration: 2s;\s*--fa-animation-timing: steps\(8\);/
        );
    });

    it("stands still under the system preference and MoltenTerm's own setting", () => {
        for (const name of ["blink", "ping", "spin"]) {
            expect(shellCss).toMatch(
                new RegExp(`\\.prefers-reduced-motion \\.mt-step-${name}[,\\s][^}]*animation: none;`)
            );
        }
        expect(shellCss).toMatch(
            /@media \(prefers-reduced-motion: reduce\) \{\s*\.mt-step-blink,\s*\.mt-step-ping,\s*\.mt-step-spin \{\s*animation: none;/
        );
    });
});

// Design tokens v2 (FR-SHELL-044, DS-SHELL-077): the colour and motion tokens of tokens.css.
const tokensCss = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

function tokenRecipe(name: string): Recipe {
    const m = new RegExp(`${name}:\\s*color-mix\\(in srgb, var\\(--mt-place\\) (\\d+)%, (rgb\\([^)]*\\))\\);`).exec(
        tokensCss
    );
    return m == null ? null : { pct: Number(m[1]), base: m[2] };
}

function tokenColour(name: string): ReturnType<typeof parseColor> {
    return parseColor(new RegExp(`${name}:\\s*(rgb\\([^)]*\\))`).exec(tokensCss)[1]);
}

describe("design tokens v2: colours (FR-SHELL-044 AC2, AC5)", () => {
    const Surfaces = ["--mt-surface-1", "--mt-surface-2", "--mt-surface-3"];
    const surface = (name: string, accent: string) => {
        const recipe = tokenRecipe(name);
        return mixColor(parseColor(accent), parseColor(recipe.base), recipe.pct);
    };
    const glyphPct = Number(
        /--mt-glyph-tone: color-mix\(in srgb, var\(--mt-glyph-color, var\(--mt-place\)\) (\d+)%, var\(--mt-text-main\)\)/.exec(
            tokensCss
        )?.[1]
    );

    it("reads every surface recipe and the glyph tone from tokens.css", () => {
        for (const name of Surfaces) {
            expect(tokenRecipe(name), name).not.toBeNull();
        }
        expect(glyphPct).toBeGreaterThan(0);
    });

    it("keeps surfaces 1 and 3 on today's panel and modal backgrounds", () => {
        expect(tokenRecipe("--mt-surface-1")).toEqual(Recipes["--mt-neutral-bg"]);
        expect(tokenRecipe("--mt-surface-3")).toEqual(Recipes["--mt-neutral-modal"]);
    });

    describe.each(WorkspaceColours)("on workspace colour %s", (accent) => {
        it.each(Texts.flatMap((text) => Surfaces.map((s) => [text, s])))("%s reads at 4.5:1 on %s", (text, s) => {
            expect(contrastRatio(resolve(text, accent), surface(s, accent))).toBeGreaterThanOrEqual(4.5);
        });

        it.each(Surfaces)("danger text and info read at 4.5:1 on %s", (s) => {
            expect(contrastRatio(tokenColour("--mt-danger-text"), surface(s, accent))).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(tokenColour("--mt-info"), surface(s, accent))).toBeGreaterThanOrEqual(4.5);
        });

        it.each(Surfaces)("every workspace's glyph tone reads at 4.5:1 on %s", (s) => {
            for (const glyph of WorkspaceColours) {
                const tone = mixColor(parseColor(glyph), resolve("--mt-text-main", accent), glyphPct);
                expect(contrastRatio(tone, surface(s, accent)), glyph).toBeGreaterThanOrEqual(4.5);
            }
        });
    });

    // The shell's only blue is the info tone; the menus' hard-coded pink became the danger text.
    it("leaves no stray blue and no #ff9a9a in MoltenTerm-owned code", () => {
        const frontend = fileURLToPath(new URL("..", import.meta.url));
        for (const dir of ["moltenterm-shell", "moltenterm-onboarding"]) {
            for (const file of readdirSync(join(frontend, dir), { recursive: true }) as string[]) {
                if (!/\.(tsx?|css)$/.test(file) || /\.test\./.test(file)) {
                    continue;
                }
                const src = readFileSync(join(frontend, dir, file), "utf8");
                expect(src, `${dir}/${file}`).not.toMatch(
                    /\b(?:text|bg|border|ring|fill|stroke|from|to)-(?:sky|blue|cyan|indigo)-\d/
                );
                expect(src.toLowerCase(), `${dir}/${file}`).not.toContain("#ff9a9a");
            }
        }
    });
});

describe("design tokens v2: motion (FR-SHELL-044 AC4, NFR-SHELL-027)", () => {
    it("has the three durations and one deceleration curve", () => {
        expect(tokensCss).toContain("--mt-duration-fast: 120ms;");
        expect(tokensCss).toContain("--mt-duration-base: 180ms;");
        expect(tokensCss).toContain("--mt-duration-slow: 240ms;");
        expect(tokensCss).toContain("--mt-ease: cubic-bezier(0.2, 0, 0, 1);");
    });

    it("makes every token duration instant under the system preference and MoltenTerm's setting", () => {
        const media = /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{([^}]*)\}/.exec(tokensCss)?.[1] ?? "";
        const setting = /\n\.prefers-reduced-motion \{([^}]*)\}/.exec(tokensCss)?.[1] ?? "";
        for (const name of ["fast", "base", "slow", "glow"]) {
            expect(media).toContain(`--mt-duration-${name}: 0ms;`);
            expect(setting).toContain(`--mt-duration-${name}: 0ms;`);
        }
    });
});

describe("focus ring (#751, #1319)", () => {
    it("draws the fixed --mt-focus, 2 px with a 2 px offset, on every control without a ring of its own", () => {
        expect(shellCss).toMatch(
            /:where\(:focus-visible\) \{\s*outline: 2px solid var\(--mt-focus-ring\);\s*outline-offset: 2px;/
        );
        expect(shellCss).toMatch(/:root \{[^}]*--mt-focus-ring: var\(--mt-focus\);/);
        expect(shellCss).toMatch(/:root \{[^}]*--mt-focus: #ffa45c;/);
    });

    it("leaves no MoltenTerm focus ring in the raw accent or in white", () => {
        const root = fileURLToPath(new URL(".", import.meta.url));
        const offenders: string[] = [];
        for (const file of readdirSync(root, { recursive: true }) as string[]) {
            if (!/\.(tsx?|css)$/.test(file) || /\.test\./.test(file)) {
                continue;
            }
            if (/focus-visible:(outline|ring)-(accent|primary)\b/.test(readFileSync(join(root, file), "utf8"))) {
                offenders.push(file);
            }
        }
        expect(offenders).toEqual([]);
    });
});

// Theme "Coulée" step 1 (#1319, FR-SHELL-004, NFR-SHELL-003): the action is molten in every workspace, the workspace
// colour only marks the place.
describe("action and place (#1319)", () => {
    const Surfaces = ["--mt-surface-1", "--mt-surface-2", "--mt-surface-3"];
    const surface = (name: string, place: string) => {
        const recipe = tokenRecipe(name);
        return mixColor(parseColor(place), parseColor(recipe.base), recipe.pct);
    };
    // The lightest surface a ring is drawn on: a key cap or a hovered row.
    const keyCap = (place: string) => resolve("--mt-neutral-key", place);

    it("has the proposal's action values", () => {
        const values: Record<string, string> = {
            "--mt-action": "#ff7c0d",
            "--mt-action-hover": "#ff9a45",
            "--mt-action-press": "#e86a00",
            "--mt-action-fg": "#1c0f04",
            "--mt-action-text": "#ff9442",
            "--mt-focus": "#ffa45c",
        };
        for (const [name, value] of Object.entries(values)) {
            expect(shellCss, name).toMatch(new RegExp(`:root \\{[^}]*${name}: ${value};`));
        }
        expect(shellCss).toMatch(/:root \{[^}]*--mt-action-wash: rgba\(255, 124, 13, 0\.12\);/);
    });

    it("points every accent alias at the action, never at the place", () => {
        const root = /\/\* Action and place[\s\S]*?:root \{([^}]*)\}/.exec(shellCss)[1];
        expect(root).toContain("--mt-accent: var(--mt-action);");
        for (const alias of [
            "--accent-color",
            "--form-element-primary-color",
            "--toggle-checked-bg-color",
            "--color-accent",
        ]) {
            expect(root).toContain(`${alias}: var(--mt-accent);`);
        }
        expect(root).toContain("--color-accentbg: var(--mt-action-wash);");
        expect(root).toContain("--color-accenthover: var(--mt-action-hover);");
        for (const slot of [
            "--df-accent: var(--mt-action);",
            "--df-accent-fg: var(--mt-action-fg);",
            "--df-tile-fg: var(--mt-action-fg);",
        ]) {
            expect(tokensCss).toContain(slot);
        }
    });

    it("reads text on the action at 4.5:1 at rest, on hover and pressed (NFR-SHELL-003)", () => {
        const want: Record<string, number> = {
            "--mt-action": 7.27,
            "--mt-action-hover": 8.9,
            "--mt-action-press": 5.8,
        };
        for (const [name, ratio] of Object.entries(want)) {
            expect(contrastRatio(ActionFg, shellToken(name)), name).toBeCloseTo(ratio, 1);
        }
    });

    describe.each(WorkspaceColours)("in workspace colour %s", (place) => {
        it.each(Surfaces)("action text reads at 4.5:1, the action and the focus ring at 3:1 on %s", (s) => {
            const bg = surface(s, place);
            expect(contrastRatio(shellToken("--mt-action-text"), bg)).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(Action, bg)).toBeGreaterThanOrEqual(3);
            expect(contrastRatio(shellToken("--mt-focus"), bg)).toBeGreaterThanOrEqual(3);
        });

        it("the focus ring reads at 3:1 on a key cap", () => {
            expect(contrastRatio(shellToken("--mt-focus"), keyCap(place))).toBeGreaterThanOrEqual(3);
        });
    });

    it("draws the place on the focused panel's frame and the sidebar's place cues", () => {
        expect(shellCss).toMatch(
            /\.block-no-highlight:not\(\.block-preview\) \.block-mask \{\s*box-shadow:\s*inset 0 0 0 1px color-mix\(in srgb, var\(--mt-place\) 55%/
        );
        const sidebarCss = readFileSync(new URL("./sidebar/sidebar.css", import.meta.url), "utf8");
        for (const cue of ["mt-sb-place-strip", "mt-sb-place-bar", "mt-sb-tile-place"]) {
            expect(sidebarCss).toMatch(new RegExp(`\\.${cue} \\{[^}]*var\\(--mt-place\\)`));
        }
    });

    it("keeps the workspace colour off the buttons, the hold-to-confirm and the suite kit", () => {
        for (const file of ["molten-button.css", "hold-to-confirm.css", "suite/suite.css"]) {
            const css = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
            expect(css, file).not.toContain("--mt-place");
        }
    });
});
