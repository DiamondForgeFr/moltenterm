// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { AttachMarginPx, attachMiddle, farEnd, RopePx, tetherLine } from "./tether-model";

describe("the line of a tether (FR-BOSS-009, AC65 to AC68, #2196)", () => {
    it("is tied at its start, as long as the distance to where the panel settles, centred on the given height", () => {
        const line = tetherLine(100, 122, 40, 16);
        expect(line.left).toBe(100);
        expect(line.width).toBe(22);
        expect(line.top + RopePx / 2).toBe(40);
    });

    it("shows the part of its width that is out while the panel is a slide back", () => {
        expect(tetherLine(100, 122, 40, 16).from).toBeCloseTo(6 / 22, 9);
        expect(tetherLine(0, 20, 0).from).toBe(1);
        expect(tetherLine(0, 20, 0, 20).from).toBe(0);
    });

    it("never starts out longer than it is nor before its anchor", () => {
        expect(tetherLine(0, 10, 0, 40).from).toBe(0);
        expect(tetherLine(0, 10, 0, -40).from).toBe(1);
    });

    it("has no length when the end is not past the start", () => {
        const line = tetherLine(50, 40, 10, 16);
        expect(line.width).toBe(0);
        expect(line.from).toBe(0);
    });

    it("has its far end on the panel's edge from the closed panel to the settled one, and through the give", () => {
        const line = tetherLine(100, 122, 40, 16);
        for (const progress of [0, 0.2, 0.5, 0.9, 1, 1.08]) {
            expect(farEnd(line, progress)).toBeCloseTo(122 - 16 * (1 - progress), 9);
        }
        expect(farEnd(line, 0)).toBe(106);
        expect(farEnd(line, 1)).toBe(122);
    });

    it("grows from its anchor when nothing of it is out at first", () => {
        const line = tetherLine(10, 30, 5);
        const grown = tetherLine(10, 30, 5, 20);
        expect(farEnd(grown, 0)).toBe(10);
        expect(farEnd(grown, 1)).toBe(30);
        expect(farEnd(line, 0)).toBe(30);
    });
});

describe("where the rope meets the panel's edge", () => {
    it("is the button's level when the panel reaches it", () => {
        expect(attachMiddle(28, 264)).toBe(28);
        expect(attachMiddle(236, 264)).toBe(236);
    });

    it("stays on the straight part of the edge, off the corners, when the panel is shorter than the button's level", () => {
        expect(attachMiddle(236, 120)).toBe(120 - AttachMarginPx);
        expect(attachMiddle(2, 264)).toBe(AttachMarginPx);
    });

    it("is the middle of a panel too short for a margin on each side", () => {
        expect(attachMiddle(100, 20)).toBe(10);
        expect(attachMiddle(100, 0)).toBe(0);
    });
});
