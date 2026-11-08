// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { isDarkPixels, MeasureSize } from "./favicon-dark";

function pixels(count: number, rgba: [number, number, number, number]): number[] {
    return Array.from({ length: count }, () => rgba).flat();
}

const Full = MeasureSize * MeasureSize;

describe("an icon too dark for the dark sidebar", () => {
    it("is one whose visible pixels are dark", () => {
        expect(isDarkPixels(pixels(Full, [20, 20, 22, 255]))).toBe(true);
        expect(isDarkPixels(pixels(Full, [0, 0, 0, 255]))).toBe(true);
    });

    it("is not one that is light or coloured", () => {
        expect(isDarkPixels(pixels(Full, [240, 240, 240, 255]))).toBe(false);
        expect(isDarkPixels(pixels(Full, [217, 74, 61, 255]))).toBe(false);
        expect(isDarkPixels(pixels(Full, [107, 91, 224, 255]))).toBe(false);
    });

    it("counts only the pixels that show: a black silhouette on a transparent ground is dark", () => {
        const silhouette = [...pixels(Full / 2, [10, 10, 10, 255]), ...pixels(Full / 2, [255, 255, 255, 0])];
        expect(isDarkPixels(silhouette)).toBe(true);
    });

    it("is not one whose few dark pixels are not the icon", () => {
        const speck = [...pixels(Full / 10, [0, 0, 0, 255]), ...pixels(Full - Full / 10, [0, 0, 0, 0])];
        expect(isDarkPixels(speck)).toBe(false);
        expect(isDarkPixels(pixels(Full, [0, 0, 0, 0]))).toBe(false);
        expect(isDarkPixels([])).toBe(false);
    });
});
