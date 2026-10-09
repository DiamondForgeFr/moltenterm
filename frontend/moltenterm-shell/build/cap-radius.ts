// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Moltenterm's dense style (FR-SHELL-005, DS-SHELL-005): no corner above 3 px. Wave sets radii in about 60 SCSS and
// TSX files; capping them in the built CSS keeps one marked patch (electron.vite.config.ts) instead of edits that
// every upstream merge would fight. Runs as a PostCSS plugin, so Wave's SCSS, Tailwind's utilities and arbitrary
// values (`rounded-[10px]`) all go through it, in dev and in builds.

export const MoltentermMaxRadiusPx = 3;

// Circles and pills are written as 50% or an "infinite" length (Tailwind's rounded-full is calc(infinity * 1px),
// compiled to 3.40282e38px): those stay round.
const CircleLengthPx = 1000;

const RadiusPropRegex = /(^|-)radius($|-)/;

function capLength(token: string): string {
    const match = /^(-?\d*\.?\d+(?:e[+-]?\d+)?)(px|rem|em)$/i.exec(token);
    if (!match) {
        return token;
    }
    const value = parseFloat(match[1]);
    const px = match[2].toLowerCase() === "px" ? value : value * 16;
    if (px <= MoltentermMaxRadiusPx || px >= CircleLengthPx) {
        return token;
    }
    return `${MoltentermMaxRadiusPx}px`;
}

export function capRadiusValue(value: string): string {
    const trimmed = value.trim();
    if (/calc\(|max\(|clamp\(/i.test(trimmed)) {
        // A computed radius (`calc(var(--block-border-radius) + 2px)`) cannot be capped token by token; an
        // "infinite" one is a circle and stays.
        return /infinity|e\+?3\d/i.test(trimmed) ? value : `${MoltentermMaxRadiusPx}px`;
    }
    return trimmed
        .split(/(\s+|\/)/)
        .map((part) => (/^\s+$|^\/$/.test(part) ? part : capLength(part)))
        .join("");
}

// The radii of the design tokens v2 (FR-SHELL-044, tokens.css): 4, 6 and 10 px, read only by MoltenTerm code through
// var(--mt-radius-*) or the rounded-4/6/10 utilities. Wave's own radii stay capped.
const TokenRadiusPropRegex = /^--mt-radius-/;

export function isRadiusProp(prop: string): boolean {
    return RadiusPropRegex.test(prop.toLowerCase()) && !TokenRadiusPropRegex.test(prop.toLowerCase());
}

type PostcssDecl = { prop: string; value: string };

export function moltentermCapRadius() {
    return {
        postcssPlugin: "moltenterm-cap-radius",
        Declaration(decl: PostcssDecl) {
            if (!isRadiusProp(decl.prop)) {
                return;
            }
            const capped = capRadiusValue(decl.value);
            if (capped !== decl.value) {
                decl.value = capped;
            }
        },
    };
}
moltentermCapRadius.postcss = true;
