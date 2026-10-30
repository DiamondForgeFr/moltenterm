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
// and a dark blue, the worst case for a glyph tone on cast iron.
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

type Rgb = ReturnType<typeof parseColor>;

// The action tokens (#1319): fixed, the same in every workspace.
function shellToken(name: string): Rgb {
    return parseColor(new RegExp(`${name}: (#[0-9a-f]{6});`).exec(shellCss)?.[1]);
}
const Action = shellToken("--mt-action");
const ActionFg = shellToken("--mt-action-fg");

// Design tokens v2 (FR-SHELL-044, DS-SHELL-077) and the cast-iron neutrals (FR-SHELL-115) of tokens.css.
const tokensCss = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const tokensRoot = /\n:root \{([^}]*)\}/.exec(tokensCss)[1];

function token(name: string): Rgb {
    return parseColor(new RegExp(`${name}: (#[0-9a-f]{6});`).exec(tokensRoot)?.[1]);
}

const Surfaces = ["--mt-surface-0", "--mt-surface-1", "--mt-surface-2", "--mt-surface-3"];
const Texts = ["--mt-text-1", "--mt-text-2", "--mt-text-3"];
// The surfaces Wave's and Tailwind's backgrounds point at: the window, the panels and the dialogs.
const Backgrounds = ["--mt-surface-0", "--mt-surface-1", "--mt-surface-3"];
const MainText = token("--mt-text-1");

// Theme "Coulée" step 2 (FR-SHELL-115, FR-SHELL-014, FR-SHELL-044, NFR-SHELL-003): surfaces, text and lines are the
// same warm grey in every workspace, so each contrast holds once for all of them.
describe("cast-iron neutrals (FR-SHELL-115)", () => {
    it("has the proposal's values", () => {
        const values: Record<string, string> = {
            "--mt-surface-0": "#141210",
            "--mt-surface-1": "#1a1815",
            "--mt-surface-2": "#23201c",
            "--mt-surface-3": "#2b2723",
            "--mt-surface-term": "#100e0c",
            "--mt-text-1": "#f2ede6",
            "--mt-text-2": "#c3bbb1",
            "--mt-text-3": "#a0968b",
            "--mt-line-control": "#857b70",
        };
        for (const [name, value] of Object.entries(values)) {
            expect(tokensRoot, name).toContain(`${name}: ${value};`);
        }
        expect(tokensRoot).toContain("--mt-line-1: rgba(242, 237, 230, 0.08);");
        expect(tokensRoot).toContain("--mt-line-2: rgba(242, 237, 230, 0.14);");
    });

    it("mixes no workspace colour into a surface, a text or a line (AC-4)", () => {
        for (const name of [...Surfaces, "--mt-surface-term", ...Texts, "--mt-line-1", "--mt-line-2"]) {
            const decl = new RegExp(`${name}:\\s*([^;]+);`).exec(tokensRoot)?.[1];
            expect(decl, name).toBeDefined();
            expect(decl, name).not.toContain("--mt-place");
        }
        const neutrals = /\/\* Cast-iron neutrals[\s\S]*?:root,\n\.mt-light \[data-mt-dark-surface\] \{([^}]*)\}/.exec(
            shellCss
        )[1];
        expect(neutrals).not.toContain("--mt-place");
    });

    it("rises from the terminal to the overlays, each surface lighter than the one under it", () => {
        const lum = (rgb: Rgb) => rgb.r + rgb.g + rgb.b;
        const order = ["--mt-surface-term", ...Surfaces].map((s) => lum(token(s)));
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(new Set(order).size).toBe(order.length);
    });

    it("keeps the earlier names as aliases of the fixed tokens", () => {
        const neutrals = /\/\* Cast-iron neutrals[\s\S]*?:root,\n\.mt-light \[data-mt-dark-surface\] \{([^}]*)\}/.exec(
            shellCss
        )[1];
        const aliases: Record<string, string> = {
            "--mt-neutral-bg": "--mt-surface-0",
            "--mt-neutral-panel": "--mt-surface-1",
            "--mt-neutral-key": "--mt-surface-2",
            "--mt-neutral-modal": "--mt-surface-3",
            "--mt-neutral-line": "--mt-text-1",
            "--mt-text-main": "--mt-text-1",
            "--mt-text-secondary": "--mt-text-2",
            "--mt-text-muted": "--mt-text-3",
            "--main-bg-color": "--mt-surface-0",
            "--modal-bg-color": "--mt-surface-3",
            "--main-text-color": "--mt-text-1",
            "--secondary-text-color": "--mt-text-2",
            "--grey-text-color": "--mt-text-3",
            "--border-color": "--mt-line-2",
            "--modal-border-color": "--mt-line-2",
            "--form-element-border-color": "--mt-line-control",
            "--keybinding-bg-color": "--mt-surface-2",
            "--color-background": "--mt-surface-0",
            "--color-modalbg": "--mt-surface-3",
            "--color-border": "--mt-line-2",
            "--color-primary": "--mt-text-1",
            "--color-secondary": "--mt-text-2",
            "--color-muted": "--mt-text-3",
        };
        for (const [alias, target] of Object.entries(aliases)) {
            expect(neutrals, alias).toContain(`${alias}: var(${target});`);
        }
    });

    it.each(Texts.flatMap((text) => Surfaces.map((s) => [text, s])))("%s reads at 4.5:1 on %s (AC-2)", (text, s) => {
        expect(contrastRatio(token(text), token(s))).toBeGreaterThanOrEqual(4.5);
    });

    it("reads the discreet text at 5.10:1 at worst, on surface 3", () => {
        expect(contrastRatio(token("--mt-text-3"), token("--mt-surface-3"))).toBeCloseTo(5.1, 1);
    });

    it.each(Surfaces)("edges a control at 3:1 on %s (WCAG 1.4.11)", (s) => {
        expect(contrastRatio(token("--mt-line-control"), token(s))).toBeGreaterThanOrEqual(3);
    });

    it.each(Surfaces)("danger text and info read at 4.5:1 on %s", (s) => {
        expect(tokensRoot).toContain("--mt-danger-text: var(--mt-state-blocked-text);");
        expect(tokensRoot).toContain("--mt-info: var(--mt-state-info);");
        expect(contrastRatio(token("--mt-state-blocked-text"), token(s))).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(token("--mt-state-info"), token(s))).toBeGreaterThanOrEqual(4.5);
    });

    it("never dims a sidebar or library text with an opacity", () => {
        const sidebarCss = readFileSync(new URL("./sidebar/sidebar.css", import.meta.url), "utf8");
        const libraryCss = readFileSync(new URL("./library/library.css", import.meta.url), "utf8");
        expect(sidebarCss).toContain("--mt-sb-fg-3: var(--mt-text-3);");
        expect(libraryCss).toContain("--mt-lib-fg-3: var(--mt-text-3);");
    });
});

// The only cues a workspace colour still draws on the cast iron (FR-SHELL-004, #1319): its glyph and its dot.
describe("place cues on cast iron (FR-SHELL-115)", () => {
    const glyphPct = Number(
        /--mt-glyph-tone: color-mix\(\s*in srgb,\s*var\(--mt-glyph-color, var\(--mt-place\)\) var\(--mt-place-tone-share, (\d+)%\),\s*var\(--mt-text-main\)\s*\)/.exec(
            tokensCss
        )?.[1]
    );

    it("reads the glyph tone from tokens.css", () => {
        expect(glyphPct).toBeGreaterThan(0);
    });

    describe.each(WorkspaceColours)("workspace colour %s", (place) => {
        it.each(Surfaces)("its glyph tone reads at 4.5:1 on %s", (s) => {
            const tone = mixColor(parseColor(place), MainText, glyphPct);
            expect(contrastRatio(tone, token(s))).toBeGreaterThanOrEqual(4.5);
        });
    });
});

describe("heat states (DS-SHELL-014)", () => {
    it("draws working, waiting and error, and cools done back to neutral", () => {
        for (const state of ["working", "waiting", "error", "done"]) {
            expect(shellCss).toContain(`[data-mt-agent-state="${state}"]::after`);
        }
        const working = /\[data-mt-agent-state="working"\]::after \{([^}]*)\}/.exec(shellCss)[1];
        // FR-SHELL-116, decision 2: an agent at work glows incandescent, never the action's orange.
        expect(working).toContain("--mt-heat: var(--mt-state-running);");
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

    it("keeps waiting violet and running incandescent distinct from the action's orange", () => {
        const orange = parseColor(MoltentermDefaultAccent);
        const distance = (a: Rgb, b: Rgb) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
        expect(distance(token("--mt-state-waiting"), orange)).toBeGreaterThan(60);
        expect(distance(token("--mt-state-running"), orange)).toBeGreaterThan(50);
        expect(distance(token("--mt-state-waiting"), token("--mt-state-running"))).toBeGreaterThan(60);
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

// Theme "Coulée" step 3: the heat scale, each state with its shape.
describe("states by heat (FR-SHELL-116)", () => {
    const Marks = ["--mt-state-blocked", "--mt-state-running", "--mt-state-ready", "--mt-state-draft"];
    const TextStates = ["--mt-state-blocked-text", "--mt-state-waiting", "--mt-state-warning", "--mt-state-info"];

    it("has the proposal's values", () => {
        const values: Record<string, string> = {
            "--mt-state-blocked": "#ee4f6b",
            "--mt-state-blocked-text": "#ff8a9a",
            "--mt-state-running": "#ffb547",
            "--mt-state-ready": "#4cc38a",
            "--mt-state-draft": "#8e8780",
            "--mt-state-waiting": "#b59cf5",
            "--mt-state-warning": "#e8d46a",
            "--mt-state-info": "#7faee6",
            "--mt-chart-1": "#82a9ee",
        };
        for (const [name, value] of Object.entries(values)) {
            expect(tokensRoot, name).toContain(`${name}: ${value};`);
        }
    });

    it("keeps the earlier state names as aliases, and Wave's warning is the straw one", () => {
        expect(tokensRoot).toContain("--mt-state-working: var(--mt-state-running);");
        expect(tokensRoot).toContain("--mt-state-error: var(--mt-state-blocked);");
        expect(tokensRoot).toContain("--mt-state-done: var(--mt-state-ready);");
        expect(shellCss).toContain("--warning-color: var(--mt-state-warning);");
        expect(shellCss).toContain("--color-warning: var(--mt-state-warning);");
        expect(shellCss).not.toMatch(/--mt-state-(working|waiting|error|done):/);
    });

    it.each(Marks.flatMap((m) => Surfaces.map((s) => [m, s])))("%s marks at 3:1 on %s (WCAG 1.4.11)", (m, s) => {
        expect(contrastRatio(token(m), token(s))).toBeGreaterThanOrEqual(3);
    });

    it.each(TextStates.flatMap((m) => Surfaces.map((s) => [m, s])))("%s reads at 4.5:1 on %s", (m, s) => {
        expect(contrastRatio(token(m), token(s))).toBeGreaterThanOrEqual(4.5);
    });

    it("gives each state its shape, so greyscale keeps them apart (WCAG 1.4.1)", () => {
        const mark = (kind: string) => new RegExp(`\\n\\.mt-state-mark\\.is-${kind} \\{([^}]*)\\}`).exec(shellCss)?.[1];
        expect(mark("blocked")).toMatch(/transform: rotate\(45deg\)/);
        expect(mark("running")).toMatch(/border: [^;]+ solid var\(--mt-state-running\);/);
        expect(mark("running")).toMatch(/border-right-color: color-mix\(in srgb, var\(--mt-state-running\) 25%/);
        expect(mark("ready")).toContain("background: var(--mt-state-ready);");
        expect(mark("draft")).toContain("border: 1.5px solid var(--mt-state-draft);");
        expect(mark("draft")).not.toContain("background");
        expect(mark("waiting")).toContain("background: var(--mt-state-waiting);");
        expect(mark("waiting")).toMatch(/box-shadow: 0 0 0 2px/);
    });

    it("turns the running arc on the shared beat only, never with an animation of its own (#473)", () => {
        const source = readFileSync(new URL("./state-mark.tsx", import.meta.url), "utf8");
        expect(source).toContain('running && "mt-beat-turn"');
        expect(source).toContain("useWorkingBeat(running)");
        expect(/\n\.mt-state-mark[^{]*\{[^}]*animation/.test(shellCss)).toBe(false);
    });

    it("draws the project charts in the fixed steel blue, not the action or a state", () => {
        expect(shellCss).toContain("--mt-chart-features: var(--mt-chart-1);");
        expect(/--mt-chart-[a-z]+: [^;]*--mt-(state|action|accent)/.test(shellCss)).toBe(false);
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

    // The worst case, over the window, panel and dialog backgrounds (fixed cast iron, FR-SHELL-115), of a text colour
    // on a `pct`% tint of the accent, which is the fixed action colour (#1319).
    function worstContrast(pct: number, text: Rgb): number {
        let worst = Infinity;
        for (const bg of Backgrounds) {
            const tint = mixColor(Action, token(bg), pct);
            worst = Math.min(worst, contrastRatio(text, tint));
        }
        return worst;
    }
    const panelText = MainText;
    const accentText = ActionFg;

    it("draws the accent's text in the action's fixed text colour", () => {
        expect(shellCss).toMatch(/:root(?:,\n[^{]*)? \{[^}]*--mt-accent-fg: var\(--mt-action-fg\);/);
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

describe("design tokens v2: colours (FR-SHELL-044 AC2, AC5)", () => {
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
        expect(shellCss).toMatch(/:root(?:,\n[^{]*)? \{[^}]*--mt-focus-ring: var\(--mt-focus\);/);
        expect(shellCss).toMatch(/:root(?:,\n[^{]*)? \{[^}]*--mt-focus: #ffa45c;/);
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
            expect(shellCss, name).toMatch(new RegExp(`:root(?:,\\n[^{]*)? \\{[^}]*${name}: ${value};`));
        }
        expect(shellCss).toMatch(/:root(?:,\n[^{]*)? \{[^}]*--mt-action-wash: rgba\(255, 124, 13, 0\.12\);/);
    });

    it("points every accent alias at the action, never at the place", () => {
        const root = /\/\* Action and place[\s\S]*?:root,\n\.mt-light \[data-mt-dark-surface\] \{([^}]*)\}/.exec(
            shellCss
        )[1];
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

    // The surfaces no longer follow the workspace (FR-SHELL-115): one check holds in every workspace, a key cap
    // (surface 2) included.
    it.each(Surfaces)("action text reads at 4.5:1, the action and the focus ring at 3:1 on %s", (s) => {
        const bg = token(s);
        expect(contrastRatio(shellToken("--mt-action-text"), bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(Action, bg)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(shellToken("--mt-focus"), bg)).toBeGreaterThanOrEqual(3);
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

    it("keeps the window, the floating sidebar, the library, the 360 carpet and the agent avatar on cast iron (AC-1)", () => {
        const sidebarCss = readFileSync(new URL("./sidebar/sidebar.css", import.meta.url), "utf8");
        const agentsCss = readFileSync(new URL("./sidebar/sidebar-agents.css", import.meta.url), "utf8");
        const lookCss = readFileSync(new URL("./window-look.css", import.meta.url), "utf8");
        const view360Css = readFileSync(new URL("./view360/view360.css", import.meta.url), "utf8");
        const libraryCss = readFileSync(new URL("./library/library.css", import.meta.url), "utf8");
        const rule = (css: string, selector: string) =>
            new RegExp(`\\n${selector.replace(/[.()[\]-]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
        expect(rule(sidebarCss, ".mt-sb-frame")).toContain("background-color: var(--mt-surface-0);");
        expect(rule(sidebarCss, ".mt-sb.is-hidden")).toContain("background: var(--mt-surface-0);");
        expect(rule(agentsCss, ".mt-sb-av")).toContain("background: var(--mt-surface-3);");
        expect(rule(libraryCss, ".mt-lib")).toContain("background: var(--mt-surface-0);");
        expect(view360Css).toContain("--mt-carpet-bg: var(--mt-surface-term);");
        for (const css of [agentsCss, lookCss, view360Css]) {
            expect(css).not.toContain("--mt-place");
        }
    });

    it("tints only the sidebar, and only when the opt-in is on (AC-3)", () => {
        const sidebarCss = readFileSync(new URL("./sidebar/sidebar.css", import.meta.url), "utf8");
        const tinted = [...sidebarCss.matchAll(/\n([^\n{]+) \{[^}]*color-mix\(in srgb, var\(--mt-place\) \d+%/g)].map(
            (m) => m[1]
        );
        expect(tinted).toEqual([".mt-sb.is-tinted::before"]);
    });

    it("keeps the workspace colour off the buttons, the hold-to-confirm and the suite kit", () => {
        for (const file of ["molten-button.css", "hold-to-confirm.css", "suite/suite.css"]) {
            const css = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
            expect(css, file).not.toContain("--mt-place");
        }
    });
});

// Theme "Coulée" step 8 (FR-SHELL-121, NFR-SHELL-003 in both themes): the light theme is a second set of the same
// tokens, on :root.mt-light. Every pair the dark theme checks above is checked again with the light values (AC-2).
describe("light theme (FR-SHELL-121)", () => {
    const lightRoot = /\n:root\.mt-light \{([^}]*)\}/.exec(tokensCss)?.[1] ?? "";

    // A light value, else the dark one: what the light theme draws.
    function light(name: string): Rgb {
        const own = new RegExp(`${name}: (#[0-9a-f]{6});`).exec(lightRoot)?.[1];
        return own != null ? parseColor(own) : (token(name) ?? shellToken(name));
    }

    const LightMarks = ["--mt-state-blocked", "--mt-state-running", "--mt-state-ready", "--mt-state-draft"];
    const LightTextStates = ["--mt-state-blocked-text", "--mt-state-waiting", "--mt-state-warning", "--mt-state-info"];

    it("has the proposal's light values", () => {
        const values: Record<string, string> = {
            "--mt-surface-0": "#efeae3",
            "--mt-surface-1": "#f8f5f0",
            "--mt-surface-2": "#ffffff",
            "--mt-surface-3": "#ffffff",
            "--mt-text-1": "#1f1a15",
            "--mt-text-2": "#4d453d",
            "--mt-text-3": "#6b6158",
            "--mt-line-control": "#8c8278",
            "--mt-action-text": "#a84a00",
            "--mt-focus": "#c25600",
            "--mt-state-blocked": "#b42e4a",
            "--mt-state-running": "#b86e00",
            "--mt-state-ready": "#1e7f52",
            "--mt-state-draft": "#77706a",
            "--mt-state-waiting": "#6e52c8",
            "--mt-state-warning": "#765a00",
            "--mt-state-info": "#2f66b0",
        };
        for (const [name, value] of Object.entries(values)) {
            expect(lightRoot, name).toContain(`${name}: ${value};`);
        }
        expect(lightRoot).toContain("--mt-line-1: rgba(31, 26, 21, 0.09);");
        expect(lightRoot).toContain("--mt-line-2: rgba(31, 26, 21, 0.16);");
    });

    it("keeps the terminal dark and the action molten (decision 7)", () => {
        expect(lightRoot).not.toContain("--mt-surface-term");
        expect(lightRoot).not.toMatch(/--mt-action:/);
        expect(lightRoot).not.toMatch(/--mt-action-fg:/);
    });

    it("never draws the molten orange as text: the accent takes the action text, the suite's ink too", () => {
        expect(lightRoot).toContain("--mt-accent: var(--mt-action-text);");
        expect(tokensCss).toMatch(/:root\.mt-light \{[^}]*--df-accent-ink: var\(--mt-action-text\);/);
        expect(contrastRatio(Action, light("--mt-surface-2"))).toBeLessThan(3);
    });

    it("keeps the dark theme as it was: the light-only tokens are not defined in dark", () => {
        for (const name of ["--mt-tone-ink", "--mt-iron", "--mt-place-tone-share"]) {
            expect(tokensRoot, name).not.toContain(`${name}:`);
        }
        expect(tokensRoot).toContain("--mt-veil: #ffffff;");
        expect(tokensRoot).toContain("--mt-sink: #000000;");
        expect(tokensRoot).toContain("--mt-state-fg: #000000;");
    });

    it("gives a dark panel (a terminal) every dark value back, and every token the light theme changes (AC-3)", () => {
        const island = /\n:root\.mt-light \[data-mt-dark-surface\] \{([^}]*)\}/.exec(tokensCss)?.[1] ?? "";
        const decls = (block: string) =>
            new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
        const dark = decls(tokensRoot);
        const back = decls(island);
        for (const [name, value] of decls(lightRoot)) {
            if (["--mt-action-text", "--mt-action-wash", "--mt-focus", "--mt-accent"].includes(name)) {
                // Declared again with the action's block of moltenterm-shell.css.
                continue;
            }
            expect(back.has(name), name).toBe(true);
            if (dark.has(name)) {
                expect(back.get(name), name).toBe(dark.get(name));
            } else if (!name.startsWith("--color-")) {
                expect(back.get(name), `${name} (${value} in light) has no dark value`).toBe("initial");
            }
        }
        expect(shellCss).toMatch(/:root,\n\.mt-light \[data-mt-dark-surface\] \{[^}]*--mt-action-text: #ff9442;/);
        expect(shellCss).toMatch(/:root,\n\.mt-light \[data-mt-dark-surface\] \{[^}]*--mt-accent: var\(--mt-action\);/);
        expect(shellCss).toMatch(
            /:root,\n\.mt-light \[data-mt-dark-surface\] \{[^}]*--main-text-color: var\(--mt-text-1\);/
        );
    });

    it.each(Texts.flatMap((text) => Surfaces.map((s) => [text, s])))("%s reads at 4.5:1 on %s (AC-2)", (text, s) => {
        expect(contrastRatio(light(text), light(s))).toBeGreaterThanOrEqual(4.5);
    });

    it.each(Surfaces)("action text and the text states read at 4.5:1, controls, marks and focus at 3:1 on %s", (s) => {
        const bg = light(s);
        for (const name of ["--mt-action-text", ...LightTextStates]) {
            expect(contrastRatio(light(name), bg), name).toBeGreaterThanOrEqual(4.5);
        }
        for (const name of ["--mt-line-control", "--mt-focus", "--mt-chart-1", ...LightMarks]) {
            expect(contrastRatio(light(name), bg), name).toBeGreaterThanOrEqual(3);
        }
    });

    it("reads the text on each solid fill at 4.5:1", () => {
        const pairs: [string, string][] = [
            ["--mt-action-fg", "--mt-action"],
            ["--mt-state-fg", "--mt-state-ready"],
            ["--mt-state-fg", "--mt-state-waiting"],
            ["--mt-state-fg", "--mt-state-draft"],
            ["--mt-state-fg", "--mt-text-3"],
            ["--mt-state-blocked-fg", "--mt-state-blocked"],
            ["--mt-state-running-fg", "--mt-state-running"],
            ["--mt-state-warning-fg", "--mt-state-warning"],
            ["--mt-text-inverse", "--mt-text-1"],
        ];
        for (const [fg, fill] of pairs) {
            expect(contrastRatio(light(fg), light(fill)), `${fg} on ${fill}`).toBeGreaterThanOrEqual(4.5);
        }
    });

    it("keeps text readable on an inset (the sink) and on a hover (the veil)", () => {
        const panel = light("--mt-surface-1");
        const inset = (pct: number) => mixColor(light("--mt-sink"), panel, pct);
        expect(contrastRatio(light("--mt-text-1"), inset(50))).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(light("--mt-text-2"), inset(35))).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(light("--mt-text-3"), inset(20))).toBeGreaterThanOrEqual(4.5);
        const hover = mixColor(light("--mt-veil"), panel, 20);
        expect(contrastRatio(light("--mt-text-1"), hover)).toBeGreaterThanOrEqual(4.5);
    });

    describe.each(WorkspaceColours)("workspace colour %s", (place) => {
        const share = Number(/--mt-place-tone-share: (\d+)%;/.exec(lightRoot)?.[1]);
        it.each(Surfaces)("its glyph tone reads at 4.5:1 on %s", (s) => {
            const tone = mixColor(parseColor(place), light("--mt-text-1"), share);
            expect(contrastRatio(tone, light(s))).toBeGreaterThanOrEqual(4.5);
        });
    });
});
