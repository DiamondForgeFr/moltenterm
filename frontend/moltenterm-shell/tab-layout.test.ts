// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    clampTabWidth,
    layoutTabs,
    moveTabId,
    PinnedTabWidth,
    tabDropIndex,
    TabMaxWidth,
    TabMinWidth,
    tabOffsets,
    TabShrinkMinWidth,
} from "./tab-layout";

describe("tab widths (FR-SHELL-056 AC1, DS-SHELL-098)", () => {
    it("follows the content between 64 and 200 px", () => {
        expect(TabMinWidth).toBe(64);
        expect(clampTabWidth(40)).toBe(TabMinWidth);
        expect(clampTabWidth(70.2)).toBe(71);
        expect(clampTabWidth(131.2)).toBe(132);
        expect(clampTabWidth(480)).toBe(TabMaxWidth);
        expect(clampTabWidth(NaN)).toBe(TabMinWidth);
    });

    it("lays tabs side by side at their own widths with room to spare", () => {
        const layout = layoutTabs([{ natural: 50 }, { natural: 70 }, { natural: 150 }, { natural: 400 }], 1000);
        expect(layout.widths).toEqual([64, 70, 150, 200]);
        expect(layout.offsets).toEqual([0, 64, 134, 284]);
        expect(layout.total).toBe(484);
        expect(layout.scrollable).toBe(false);
    });

    it("keeps short tabs at their own width while the long ones shrink", () => {
        const layout = layoutTabs([{ natural: 70 }, { natural: 200 }, { natural: 200 }], 330);
        expect(layout.widths).toEqual([70, 130, 130]);
    });

    it("draws the pinned Project tab at 32 px whatever its content", () => {
        const layout = layoutTabs([{ natural: 120, pinned: true }, { natural: 120 }], 1000);
        expect(layout.widths).toEqual([PinnedTabWidth, 120]);
        expect(layout.offsets).toEqual([0, 32]);
    });

    it("shrinks the widest tabs first when the strip is short", () => {
        const layout = layoutTabs([{ natural: 100 }, { natural: 200 }, { natural: 200 }], 400);
        expect(layout.widths).toEqual([100, 150, 150]);
        expect(layout.total).toBe(400);
        expect(layout.scrollable).toBe(false);
    });

    it("keeps the pinned tab's room before shrinking the others", () => {
        const layout = layoutTabs([{ natural: 0, pinned: true }, { natural: 200 }, { natural: 200 }], 332);
        expect(layout.widths).toEqual([32, 150, 150]);
    });

    it("never shrinks a name under 96 px and scrolls instead", () => {
        const layout = layoutTabs([{ natural: 70 }, ...Array.from({ length: 10 }, () => ({ natural: 180 }))], 500);
        expect(layout.widths[0]).toBe(70);
        expect(new Set(layout.widths.slice(1))).toEqual(new Set([TabShrinkMinWidth]));
        expect(layout.scrollable).toBe(true);
    });
});

describe("dragging a tab among tabs of different widths", () => {
    it("computes offsets in order", () => {
        expect(tabOffsets([32, 100, 200])).toEqual([0, 32, 132]);
    });

    it("stays put at rest", () => {
        expect(tabDropIndex([100, 200, 100], 1, 100)).toBe(1);
        expect(tabDropIndex([96, 60, 200], 1, 96)).toBe(1);
    });

    it("passes a neighbour on the right once its right edge crosses the neighbour's centre", () => {
        const widths = [100, 200, 100];
        // The 200 px neighbour's centre is at 200: the dragged tab's right edge (left + 100) must pass it.
        expect(tabDropIndex(widths, 0, 90)).toBe(0);
        expect(tabDropIndex(widths, 0, 110)).toBe(1);
        expect(tabDropIndex(widths, 0, 260)).toBe(2);
    });

    it("passes a neighbour on the left once its left edge crosses the neighbour's centre", () => {
        const widths = [100, 200, 100];
        expect(tabDropIndex(widths, 2, 300)).toBe(2);
        expect(tabDropIndex(widths, 2, 210)).toBe(2);
        expect(tabDropIndex(widths, 2, 190)).toBe(1);
        expect(tabDropIndex(widths, 2, 40)).toBe(0);
    });

    it("lets a wide tab reach the start of the strip", () => {
        expect(tabDropIndex([32, 96, 200], 2, 32, 1)).toBe(1);
    });

    it("never lands before the pinned tabs", () => {
        expect(tabDropIndex([32, 100, 100], 2, 0, 1)).toBe(1);
    });

    it("moves an id in a copy", () => {
        const ids = ["a", "b", "c"];
        expect(moveTabId(ids, 0, 2)).toEqual(["b", "c", "a"]);
        expect(moveTabId(ids, 2, 0)).toEqual(["c", "a", "b"]);
        expect(moveTabId(ids, 1, 1)).toBe(ids);
        expect(ids).toEqual(["a", "b", "c"]);
    });
});
