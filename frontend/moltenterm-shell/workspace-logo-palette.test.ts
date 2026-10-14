// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseColor } from "./accent";
import { extractPalette } from "./workspace-logo-palette";

type Pixel = [number, number, number, number];

const Side = 64;
const Transparent: Pixel = [0, 0, 0, 0];
const White: Pixel = [255, 255, 255, 255];

// A logo fixture: RGBA pixels of a Side x Side image, painted per pixel.
function image(paint: (x: number, y: number) => Pixel): Uint8ClampedArray {
    const data = new Uint8ClampedArray(Side * Side * 4);
    for (let y = 0; y < Side; y++) {
        for (let x = 0; x < Side; x++) {
            data.set(paint(x, y), (y * Side + x) * 4);
        }
    }
    return data;
}

function hex(colour: string): Pixel {
    const { r, g, b } = parseColor(colour);
    return [r, g, b, 255];
}

function near(actual: string, expected: string, tolerance = 24) {
    const a = parseColor(actual);
    const e = parseColor(expected);
    const d = Math.max(Math.abs(a.r - e.r), Math.abs(a.g - e.g), Math.abs(a.b - e.b));
    expect(d, `${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
}

const inCircle = (x: number, y: number, cx: number, cy: number, r: number) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

describe("extractPalette (#657 AC1, AC5)", () => {
    it("finds a transparent logo's two colours, most covering first, without its outline and text", () => {
        const data = image((x, y) => {
            if (y >= 54 && y < 58 && x >= 8 && x < 56) {
                return White; // the name under the mark
            }
            if (inCircle(x, y, 32, 26, 22) && !inCircle(x, y, 32, 26, 21)) {
                return [10, 10, 10, 255]; // the outline
            }
            if (inCircle(x, y, 32, 26, 21)) {
                // The mark's bar, then the disc, with an antialiased shade at the edge.
                if (y >= 22 && y < 30) {
                    return hex("#1572b6");
                }
                return inCircle(x, y, 32, 26, 20) ? hex("#e34f26") : hex("#e85a33");
            }
            return Transparent;
        });
        const palette = extractPalette(data);
        expect(palette).toHaveLength(2);
        near(palette[0], "#e34f26");
        near(palette[1], "#1572b6");
    });

    it("leaves an opaque logo's white paper out and keeps up to 4 colours", () => {
        const data = image((x, y) => {
            if (x < 16 && y < 32) return hex("#d62828");
            if (x >= 16 && x < 32 && y < 32) return hex("#2a9d8f");
            if (x >= 32 && x < 48 && y < 24) return hex("#f4a261");
            if (x >= 48 && y < 16) return hex("#6d597a");
            if (x < 8 && y >= 56) return hex("#3a86ff");
            return White;
        });
        const palette = extractPalette(data);
        expect(palette).toHaveLength(4);
        near(palette[0], "#d62828");
        near(palette[1], "#2a9d8f");
        near(palette[2], "#f4a261");
        near(palette[3], "#6d597a");
        expect(extractPalette(data, 2)).toHaveLength(2);
    });

    it("counts a soft shading as one colour", () => {
        const data = image((x) => [48 + Math.round(x / 8), 96 + Math.round(x / 4), 192 + Math.round(x / 4), 255]);
        const palette = extractPalette(data);
        expect(palette).toHaveLength(1);
        near(palette[0], "#3a6ec8", 16);
    });

    it("leaves out a stray detail", () => {
        const data = image((x, y) => {
            if (x < 2 && y < 2) return hex("#ff00aa");
            return y < 32 ? hex("#ffb703") : Transparent;
        });
        const palette = extractPalette(data);
        expect(palette).toHaveLength(1);
        near(palette[0], "#ffb703", 0);
    });

    it("offers nothing for a black and white logo, a transparent image or no pixels", () => {
        const blackOnWhite = image((x, y) => (inCircle(x, y, 32, 32, 20) ? [5, 5, 5, 255] : White));
        expect(extractPalette(blackOnWhite)).toEqual([]);
        expect(extractPalette(image(() => [255, 0, 0, 40]))).toEqual([]);
        expect(extractPalette(new Uint8ClampedArray(0))).toEqual([]);
    });

    it("keeps offered colours apart: two near shades are not both offered", () => {
        const data = image((x) => (x < 32 ? hex("#429dff") : hex("#4aa5ff")));
        expect(extractPalette(data)).toHaveLength(1);
    });
});
