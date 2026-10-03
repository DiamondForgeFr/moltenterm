// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { launcherGrid, launcherLogo, launcherLogoReservedHeight } from "./launcher-layout";

function lastRow(count: number, columns: number): number {
    return count % columns || columns;
}

describe("launcherGrid", () => {
    it("lays seven widgets out without a tile alone on the last row", () => {
        const grid = launcherGrid(7, 800, 600);
        expect(grid.columns).toBe(4);
        expect(lastRow(7, grid.columns)).toBeGreaterThan(1);
    });

    it.each([
        [7, 600, 500],
        [7, 1200, 400],
        [4, 600, 500],
        [5, 700, 500],
        [10, 900, 700],
    ])("leaves no orphan for %i widgets in %ix%i", (count, width, height) => {
        const grid = launcherGrid(count, width, height);
        expect(lastRow(count, grid.columns)).toBeGreaterThan(1);
    });

    it("keeps one row in a wide, short pane", () => {
        expect(launcherGrid(7, 1400, 140).columns).toBe(7);
    });

    it("keeps one column in a tall, narrow pane", () => {
        expect(launcherGrid(3, 80, 900).columns).toBe(1);
    });

    it("accepts an orphan when avoiding it would shrink the tiles too much", () => {
        // Three columns give 7 tiles of ~45 px; four columns only ~35 px.
        const grid = launcherGrid(7, 150, 170);
        expect(grid.columns).toBe(3);
    });

    it("falls back to a default layout before the pane is measured", () => {
        expect(launcherGrid(7, 0, 0)).toEqual({ columns: 1, tileWidth: 90, tileHeight: 90, showLabel: true });
        expect(launcherGrid(0, 800, 600).columns).toBe(1);
    });
});

describe("launcherLogo", () => {
    it("stays small in a large pane", () => {
        const logo = launcherLogo(1600);
        expect(logo.show).toBe(true);
        expect(logo.width).toBeLessThanOrEqual(72);
    });

    it("is hidden in a narrow pane and reserves no height", () => {
        const logo = launcherLogo(120);
        expect(logo.show).toBe(false);
        expect(launcherLogoReservedHeight(logo)).toBe(0);
    });
});
