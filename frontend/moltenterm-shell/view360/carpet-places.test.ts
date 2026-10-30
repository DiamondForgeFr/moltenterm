// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { FixedMinPx, ReadableCarpetColumnPx } from "./carpet-model";
import {
    besideZonePx,
    effectivePlaces,
    nearestScrollStop,
    nextScrollStop,
    placeOptions,
    placesFixedPx,
    placesShareSlotPx,
    placesSlotPx,
    placesStartIndex,
    readPlaces,
} from "./carpet-places";

function offered(carpetColumns: number, width: number, floorPx = 0): number[] {
    return placeOptions(carpetColumns, width, floorPx)
        .filter((o) => o.offered)
        .map((o) => o.n);
}

describe("offered counts (FR-SHELL-123-AC3, AC4)", () => {
    it("offers only the numbers that store at least one panel", () => {
        expect(offered(1, 3160)).toEqual([]);
        expect(offered(2, 3160)).toEqual([1]);
        expect(offered(3, 3160)).toEqual([1, 2]);
        expect(offered(4, 3160)).toEqual([1, 2, 3]);
        expect(offered(6, 3160)).toEqual([1, 2, 3]);
    });

    it("offers what fits at each usable width", () => {
        expect(offered(4, 1200)).toEqual([1]);
        expect(offered(4, 1450)).toEqual([1, 2]);
        expect(offered(4, 2280)).toEqual([1, 2, 3]);
        expect(offered(4, 3160)).toEqual([1, 2, 3]);
    });

    it("greys a number with its reason, nothing to store before too narrow", () => {
        const options = placeOptions(2, 1200);
        expect(options.map((o) => o.reason ?? "ok")).toEqual(["ok", "nothing", "nothing"]);
        const narrow = placeOptions(6, 1200);
        expect(narrow.map((o) => o.reason ?? "ok")).toEqual(["ok", "narrow", "narrow"]);
        expect(narrow[0].stored).toBe(5);
        expect(narrow[1].slotPx).toBeLessThan(ReadableCarpetColumnPx);
    });

    it("counts the terminal floor and the columns pinned beside", () => {
        expect(offered(4, 1450)).toEqual([1, 2]);
        expect(offered(4, 1450, 700)).toEqual([1]);
        expect(placeOptions(4, 1450, 0, besideZonePx([320]))[1].offered).toBe(false);
    });
});

describe("equal parts (AC5)", () => {
    it("gives the fixed zone and each place the same share when the bounds allow it", () => {
        const width = 3160;
        for (const n of [1, 2, 3]) {
            const fixed = placesFixedPx(width, n);
            expect(Math.abs(fixed - placesSlotPx(width, fixed, n))).toBeLessThanOrEqual(1);
        }
        expect(placesFixedPx(2280, 3)).toBeCloseTo(540, 0);
    });

    it("keeps the fixed zone's 520 px, the places sharing what it leaves", () => {
        const fixed = placesFixedPx(1450, 2);
        expect(fixed).toBe(FixedMinPx);
        expect(placesShareSlotPx(1450, 2)).toBeCloseTo((1450 - FixedMinPx - 108) / 2, 0);
    });

    it("keeps the terminal floor, beyond half of the window when it needs more", () => {
        expect(placesFixedPx(2280, 1, 800)).toBe(1092);
        expect(placesFixedPx(2280, 3, 800)).toBe(800);
        expect(placesFixedPx(1600, 1, 900)).toBe(900);
        expect(placesFixedPx(1600, 3, 900)).toBe(900);
    });

    it("never gives the fixed zone more than half without a floor", () => {
        expect(placesFixedPx(1200, 1)).toBeLessThanOrEqual(600);
        expect(placesFixedPx(4000, 1)).toBeLessThanOrEqual(2000);
    });
});

describe("shown places (AC7)", () => {
    it("shows the largest number that still fits, at least one", () => {
        expect(effectivePlaces(3, 2280)).toBe(3);
        expect(effectivePlaces(3, 1450)).toBe(2);
        expect(effectivePlaces(3, 1200)).toBe(1);
        expect(effectivePlaces(2, 700)).toBe(1);
    });
});

describe("placement (AC6)", () => {
    it("puts the panel first, its left neighbours filling in when it is near the end", () => {
        expect(placesStartIndex(0, 5, 2)).toBe(0);
        expect(placesStartIndex(2, 5, 2)).toBe(2);
        expect(placesStartIndex(4, 5, 2)).toBe(3);
        expect(placesStartIndex(4, 5, 1)).toBe(4);
        expect(placesStartIndex(4, 5, 3)).toBe(2);
        expect(placesStartIndex(-1, 5, 2)).toBe(0);
    });
});

describe("scroll steps (AC7)", () => {
    const stops = [0, 600, 1200, 1800];
    it("steps to the next stop in a direction, never between two", () => {
        expect(nextScrollStop(stops, 0, 1)).toBe(600);
        expect(nextScrollStop(stops, 300, 1)).toBe(600);
        expect(nextScrollStop(stops, 600, -1)).toBe(0);
        expect(nextScrollStop(stops, 1800, 1)).toBe(1800);
        expect(nextScrollStop(stops, 0, -1)).toBe(0);
        expect(nearestScrollStop(stops, 1000)).toBe(1200);
    });
});

describe("stored N", () => {
    it("reads 1, 2 or 3 only", () => {
        expect(readPlaces(2)).toBe(2);
        expect(readPlaces(0)).toBeNull();
        expect(readPlaces(4)).toBeNull();
        expect(readPlaces("2")).toBeNull();
        expect(readPlaces(null)).toBeNull();
    });
});
