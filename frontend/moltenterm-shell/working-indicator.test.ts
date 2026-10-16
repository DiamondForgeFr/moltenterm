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

    it("steps the dominoes on a 1/24 s grid (NFR-MC-004)", () => {
        expect(shellCss).toMatch(
            /\.df-dominos > span,\s*\.df-domino-loader > span \{\s*animation-name: mt-dominos-24;\s*animation-timing-function: step-end;/
        );
        const delays = [22, 19, 16, 13, 10, 7, 3];
        delays.forEach((n, i) => {
            expect(shellCss).toMatch(
                new RegExp(
                    `\\.df-domino-loader > span:nth-child\\(${i + 2}\\) \\{\\s*animation-delay: calc\\(${n}s / 24\\);`
                )
            );
        });
        const frames = /@keyframes mt-dominos-24 \{([\s\S]*?)\n\}/.exec(shellCss)?.[1] ?? "";
        expect(frames.match(/^\s*[\d.]+% \{/gm)).toHaveLength(24);
        expect(frames).toMatch(/75% \{\s*opacity: 1;\s*transform: rotate\(90deg\);/);
    });

    it("stands the dominoes still under reduced motion and in an inactive view", () => {
        for (const sel of [".prefers-reduced-motion", ':root[data-mt-motion="still"]']) {
            for (const kind of ["df-dominos", "df-domino-loader"]) {
                expect(shellCss).toContain(`${sel} .${kind} > span`);
            }
        }
        expect(shellCss).toMatch(
            /:root\[data-mt-motion="still"\] \.df-domino-loader > span \{\s*animation: none;\s*\}\s*@media \(prefers-reduced-motion: reduce\) \{\s*\.df-dominos > span,\s*\.df-domino-loader > span \{\s*animation: none;/
        );
    });
});
