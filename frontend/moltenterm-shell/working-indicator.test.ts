// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The suite's falling dominoes are MoltenTerm's one working indicator (#739 AC2): no spinner glyph says "working" or
// "loading" in the shell. A refresh button whose own arrows turn while it refreshes keeps them (the icon means
// "refresh"); those few are listed below.

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const ShellDir = __dirname;

const SpinnerPatterns: RegExp[] = [
    /\bfa-spinner\b/,
    /\bfa-circle-notch\b/,
    /\banimate-spin\b/,
    /makeIconClass\(\s*["']spinner["']/,
    /\bfa-spin-pulse\b/,
];

// fa-spin is allowed only on a refresh button's own arrows.
const RefreshArrows = /\bfa-(?:rotate|rotate-right|arrows-rotate)\b[^"\n]*"[^\n]*\bfa-spin\b/;

function shellSources(): { file: string; text: string }[] {
    return (readdirSync(ShellDir, { recursive: true }) as string[])
        .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
        .map((f) => ({ file: f, text: readFileSync(join(ShellDir, f), "utf8") }));
}

const shellCss = readFileSync(join(ShellDir, "moltenterm-shell.css"), "utf8");

// The kit's df-dominos curve (suite.css): 0° to 90° at 75 % then back, opacity 1 to 0.7 at 50 % and back to 1 at 80 %,
// each segment eased. The bars fall 0, 14, 12... 2 fifteenths of the cycle apart (the kit's delays, #1399).
const DominoSteps = 15;
const DominoOffsets = [0, 14, 12, 10, 8, 6, 4, 2];

function cssEase(x: number): number {
    const [x1, y1, x2, y2] = [0.25, 0.1, 0.25, 1];
    const bez = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (bez(mid, x1, x2) < x) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return bez((lo + hi) / 2, y1, y2);
}

function eased(points: [number, number][], p: number): number {
    for (let i = 0; i < points.length - 1; i++) {
        const [p0, v0] = points[i];
        const [p1, v1] = points[i + 1];
        if (p >= p0 && p <= p1) {
            return v0 + (v1 - v0) * cssEase((p - p0) / (p1 - p0));
        }
    }
    return points[points.length - 1][1];
}

const kitAngle = (p: number) =>
    eased(
        [
            [0, 0],
            [0.75, 90],
            [1, 0],
        ],
        p
    );
const kitOpacity = (p: number) =>
    eased(
        [
            [0, 1],
            [0.5, 0.7],
            [0.8, 1],
            [1, 1],
        ],
        p
    );

describe("working indicator (#739)", () => {
    it("leaves no working or loading spinner in the shell", () => {
        const found: string[] = [];
        for (const { file, text } of shellSources()) {
            text.split("\n").forEach((line, i) => {
                if (SpinnerPatterns.some((re) => re.test(line))) {
                    found.push(`${file}:${i + 1}`);
                }
                if (/\bfa-spin\b/.test(line) && !RefreshArrows.test(line)) {
                    found.push(`${file}:${i + 1}`);
                }
            });
        }
        expect(found).toEqual([]);
    });

    it("steps the dominoes 15 times a cycle, each bar on its own keyframes and without delay (NFR-MC-004, #1399)", () => {
        expect(shellCss).toMatch(
            /@media \(prefers-reduced-motion: no-preference\) \{\s*\.df-dominos > span,\s*\.df-domino-loader > span \{\s*animation-name: mt-dominos-1;\s*animation-duration: var\(--mt-duration-dominoes\);\s*animation-timing-function: step-end;\s*animation-delay: 0s;/
        );
        expect(shellCss).not.toMatch(/\.df-domino(?:s|-loader) > span:nth-child\(\d\) \{\s*animation-delay/);
        for (let bar = 2; bar <= 8; bar++) {
            expect(shellCss).toMatch(
                new RegExp(
                    `\\.df-dominos > span:nth-child\\(${bar}\\),\\s*\\.df-domino-loader > span:nth-child\\(${bar}\\) \\{\\s*animation-name: mt-dominos-${bar};`
                )
            );
        }
    });

    it("samples each bar's keyframes from the kit's curve, shifted by the bar's place in the fall", () => {
        for (let bar = 1; bar <= 8; bar++) {
            const body = new RegExp(`@keyframes mt-dominos-${bar} \\{([\\s\\S]*?)\\n\\}`).exec(shellCss)?.[1] ?? "";
            const frames = [...body.matchAll(/([\d.]+)% \{\s*opacity: ([\d.]+);\s*transform: rotate\(([\d.]+)deg\);/g)];
            expect(frames, `bar ${bar}`).toHaveLength(DominoSteps);
            frames.forEach((m, k) => {
                expect(Number(m[1])).toBeCloseTo((k * 100) / DominoSteps, 2);
                const phase =
                    ((((k - DominoOffsets[bar - 1]) % DominoSteps) + DominoSteps) % DominoSteps) / DominoSteps;
                expect(Math.abs(Number(m[2]) - kitOpacity(phase)), `bar ${bar} step ${k}`).toBeLessThan(0.006);
                expect(Math.abs(Number(m[3]) - kitAngle(phase)), `bar ${bar} step ${k}`).toBeLessThan(0.06);
            });
        }
    });

    it("stands the dominoes still under reduced motion and in an inactive view", () => {
        for (const sel of [".prefers-reduced-motion", ':root[data-mt-motion="still"]']) {
            for (const kind of ["df-dominos", "df-domino-loader"]) {
                expect(shellCss).toContain(`${sel} .${kind} > span`);
            }
        }
        expect(shellCss).toMatch(
            /:root\[data-mt-motion="still"\] \.df-domino-loader > span \{\s*animation: none;\s*transform: rotate\(var\(--df-domino-still, 0deg\)\);\s*\}\s*@media \(prefers-reduced-motion: reduce\) \{\s*\.df-dominos > span,\s*\.df-domino-loader > span \{\s*animation: none;\s*transform: rotate\(var\(--df-domino-still, 0deg\)\);/
        );
    });

    it("stands them still in a frame of the fall, never a flat dash (#1073)", () => {
        const kitCss = readFileSync(join(ShellDir, "suite", "suite.css"), "utf8");
        const angles = [2, 3, 4, 5, 6, 7, 8].map((n) => {
            const m = new RegExp(
                `\\.df-dominos > span:nth-child\\(${n}\\),\\s*\\.df-domino-loader > span:nth-child\\(${n}\\) \\{\\s*--df-domino-still: (\\d+)deg;`
            ).exec(kitCss);
            return m ? Number(m[1]) : null;
        });
        expect(angles).not.toContain(null);
        for (let i = 1; i < angles.length; i++) {
            expect(angles[i]).toBeGreaterThan(angles[i - 1]);
        }
        expect(angles[0]).toBeGreaterThan(0);
        expect(angles[angles.length - 1]).toBe(90);
    });
});
