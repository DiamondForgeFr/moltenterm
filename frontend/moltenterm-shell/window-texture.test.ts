// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    clampTextureIntensity,
    DefaultTextureIntensity,
    inkAlpha,
    MaxInk,
    MinTextureIntensity,
    textureBackground,
    TextureKinds,
    TextureTone,
} from "./window-texture";

const Textures = TextureKinds.filter((k) => k !== "none");

function svgOf(image: string): string {
    const match = /^url\("data:image\/svg\+xml,(.*)"\)$/.exec(image);
    return match ? decodeURIComponent(match[1]) : null;
}

describe("generated backgrounds (#1294, TC-SHELL-224)", () => {
    it("are the same for the same settings, and differ when a setting changes", () => {
        for (const kind of Textures) {
            for (const tone of ["light", "dark"] as TextureTone[]) {
                const a = textureBackground(kind, 0.6, tone);
                expect(textureBackground(kind, 0.6, tone)).toBe(a);
                expect(textureBackground(kind, 0.6, tone).image).toEqual(a.image);
            }
            expect(textureBackground(kind, 0.6, "light").image).not.toEqual(textureBackground(kind, 0.6, "dark").image);
        }
        expect(textureBackground("grain", 0.4, "light").image).not.toEqual(
            textureBackground("grain", 0.8, "light").image
        );
    });

    it("are a small SVG written here: no file, no script, no animation, a fixed seed", () => {
        for (const kind of Textures) {
            const bg = textureBackground(kind, 1, "light");
            const svg = svgOf(bg.image);
            expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
            expect(svg).not.toMatch(/<image|href=|<script|<animate|<set |http:\/\/(?!www.w3.org\/2000\/svg)/);
            expect(svg.length).toBeLessThan(800);
            expect(bg.size).toMatch(/^\d+px \d+px$/);
            if (svg.includes("feTurbulence")) {
                expect(svg).toContain('seed="7"');
                expect(svg).toContain('stitchTiles="stitch"');
            }
        }
    });

    it("draws nothing for none or an unknown kind", () => {
        expect(textureBackground("none", 1, "light")).toBeNull();
        expect(textureBackground("plaid" as any, 1, "light")).toBeNull();
    });

    it("keeps the grain's intensity on 10 % steps from 20 % to 100 %, the patterns fixed", () => {
        expect(clampTextureIntensity(0.05)).toBe(MinTextureIntensity);
        expect(clampTextureIntensity(1.3)).toBe(1);
        expect(clampTextureIntensity(0.44)).toBe(0.4);
        expect(clampTextureIntensity(NaN)).toBe(DefaultTextureIntensity);
        expect(inkAlpha("grain", 1, "light")).toBe(MaxInk.grain.light);
        expect(inkAlpha("grain", 0.5, "light")).toBe(MaxInk.grain.light / 2);
        expect(inkAlpha("dots", 0.2, "light")).toBe(MaxInk.dots.light);
        expect(inkAlpha("none", 1, "light")).toBe(0);
    });

    it("never draws a pixel more opaque than the ink's highest alpha", () => {
        for (const kind of Textures) {
            const alpha = inkAlpha(kind, 1, "light");
            const svg = svgOf(textureBackground(kind, 1, "light").image);
            const matrix = /values="([^"]+)"/.exec(svg);
            if (matrix) {
                const v = matrix[1].split(" ").map(Number);
                // A' = v[15] * noise + v[19], noise in 0..1.
                expect(v[15] + v[19]).toBeCloseTo(alpha, 3);
            } else {
                const opacities = [...svg.matchAll(/-opacity="([\d.]+)"/g)].map((m) => Number(m[1]));
                expect(opacities.length).toBeGreaterThan(0);
                opacities.forEach((o) => expect(o).toBeLessThanOrEqual(alpha));
            }
        }
    });
});

describe("the sidebar's text over a texture (#1294, TC-SHELL-225)", () => {
    const lin = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const lum = (rgb: number[]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
    const contrast = (a: number[], b: number[]) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
    };
    const over = (top: number[], alpha: number, under: number[]) =>
        under.map((c, i) => alpha * top[i] + (1 - alpha) * c);
    const White = [255, 255, 255];
    const Black = [0, 0, 0];

    // Every accent on a 0/64/…/255 grid, white the lightest: the frame's tint (sidebar.css) and the text (--mt-text-main).
    const accents: number[][] = [];
    for (const r of [0, 64, 128, 192, 255]) {
        for (const g of [0, 64, 128, 192, 255]) {
            for (const b of [0, 64, 128, 192, 255]) {
                accents.push([r, g, b]);
            }
        }
    }
    const tintOf = (accent: number[]) => over(accent, 0.18, [20, 17, 16]);
    const textOf = (accent: number[]) => over(accent, 0.03, [247, 247, 247]);

    it("keeps 4.5:1 at the lightest spot of every texture at full intensity, under a hovered row's highlight", () => {
        let worst = Infinity;
        for (const kind of Textures) {
            const alpha = inkAlpha(kind, 1, "light");
            for (const accent of accents) {
                const spot = over(White, 0.1, over(White, alpha, tintOf(accent)));
                worst = Math.min(worst, contrast(textOf(accent), spot));
            }
        }
        expect(worst).toBeGreaterThanOrEqual(4.5);
    });

    it("only darkens a see-through frame, so the opacity's own minimum holds", () => {
        for (const kind of Textures) {
            const alpha = inkAlpha(kind, 1, "dark");
            for (const accent of accents) {
                const behind = over(tintOf(accent), 0.7, White);
                const spot = over(Black, alpha, behind);
                expect(contrast(textOf(accent), spot)).toBeGreaterThanOrEqual(contrast(textOf(accent), behind));
            }
        }
    });
});
