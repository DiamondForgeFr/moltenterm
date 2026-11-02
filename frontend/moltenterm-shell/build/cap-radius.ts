// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Moltenterm's two radii (FR-SHELL-005, FR-SHELL-118, DS-SHELL-005): the control radius, 4 px, and the panel radius,
// 6 px (tokens.css). Wave sets radii in about 60 SCSS and TSX files; snapping them onto the two in the built CSS keeps
// one marked patch (electron.vite.config.ts) instead of edits that every upstream merge would fight. Runs as a
// PostCSS plugin, so Wave's SCSS, Tailwind's utilities and arbitrary values (`rounded-[10px]`) all go through it, in
// dev and in builds.

export const MoltentermControlRadiusPx = 4;
export const MoltentermPanelRadiusPx = 6;

// Circles and pills are written as 50% or an "infinite" length (Tailwind's rounded-full is calc(infinity * 1px),
// compiled to 3.40282e38px): those stay round.
const CircleLengthPx = 1000;

const RadiusPropRegex = /(^|-)radius($|-)/;

// A corner of up to the control radius is a control's, a bigger one a panel's.
function snapLength(token: string): string {
    const match = /^(-?\d*\.?\d+(?:e[+-]?\d+)?)(px|rem|em)$/i.exec(token);
    if (!match) {
        return token;
    }
    const value = parseFloat(match[1]);
    const px = match[2].toLowerCase() === "px" ? value : value * 16;
    if (px <= 0 || px >= CircleLengthPx) {
        return token;
    }
    return `${px <= MoltentermControlRadiusPx ? MoltentermControlRadiusPx : MoltentermPanelRadiusPx}px`;
}

export function snapRadiusValue(value: string): string {
    const trimmed = value.trim();
    if (/calc\(|max\(|clamp\(/i.test(trimmed)) {
        // A computed radius (`calc(var(--block-border-radius) + 2px)`, Wave's tile around a panel) cannot be snapped
        // token by token, and it would land between the two; an "infinite" one is a circle and stays.
        return /infinity|e\+?3\d/i.test(trimmed) ? value : `${MoltentermPanelRadiusPx}px`;
    }
    return trimmed
        .split(/(\s+|\/)/)
        .map((part) => (/^\s+$|^\/$/.test(part) ? part : snapLength(part)))
        .join("");
}

// The radii of the design tokens (FR-SHELL-118, tokens.css): --mt-radius-control and --mt-radius-panel, read only by
// MoltenTerm code through var(--mt-radius-*) or the rounded-4/6 utilities, and the DiamondForge suite kit's
// --df-radius-* (#658). Wave's own radii are snapped.
const TokenRadiusPropRegex = /^--(?:mt|df)-radius-/;

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
            const snapped = snapRadiusValue(decl.value);
            if (snapped !== decl.value) {
                decl.value = snapped;
            }
        },
    };
}
moltentermCapRadius.postcss = true;
