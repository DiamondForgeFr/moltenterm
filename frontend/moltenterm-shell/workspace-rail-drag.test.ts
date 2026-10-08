// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    autoScrollStep,
    dropLineY,
    dropSlot,
    passedDragThreshold,
    RailAutoScrollMaxPx,
    RailAutoScrollZonePx,
    RailDragThresholdPx,
    RailItemBox,
    railMoveKey,
} from "./workspace-rail-drag";

// Four 36 px items, 4 px apart, from y = 10.
const boxes: RailItemBox[] = ["a", "b", "c", "d"].map((id, i) => ({ id, top: 10 + i * 40, bottom: 46 + i * 40 }));

describe("drag threshold (FR-MC-031-AC2)", () => {
    it("is a click below the threshold and a drag from it, either way", () => {
        expect(passedDragThreshold(100, 100 + RailDragThresholdPx - 1)).toBe(false);
        expect(passedDragThreshold(100, 100 + RailDragThresholdPx)).toBe(true);
        expect(passedDragThreshold(100, 100 - RailDragThresholdPx)).toBe(true);
    });

    it("is smaller than one rail slot", () => {
        expect(RailDragThresholdPx).toBeLessThan(40);
    });
});

describe("dropSlot", () => {
    it("counts the other items whose middle is above the pointer", () => {
        expect(dropSlot(boxes, "d", 0)).toBe(0);
        expect(dropSlot(boxes, "d", 29)).toBe(1);
        expect(dropSlot(boxes, "d", 69)).toBe(2);
        expect(dropSlot(boxes, "a", 500)).toBe(3);
    });

    it("ignores the dragged item itself", () => {
        expect(dropSlot(boxes, "b", 75)).toBe(1);
    });
});

describe("dropLineY", () => {
    it("sits in the gap between the two items around the slot", () => {
        expect(dropLineY(boxes, "d", 1)).toBe(48);
    });

    it("sits just past the first or the last item at the ends", () => {
        expect(dropLineY(boxes, "d", 0)).toBe(8);
        expect(dropLineY(boxes, "a", 3)).toBe(168);
    });

    it("has no line without other items", () => {
        expect(dropLineY([boxes[0]], "a", 0)).toBeNull();
    });
});

describe("autoScrollStep (FR-MC-031-AC1)", () => {
    const top = 0;
    const bottom = 400;

    it("does not scroll away from the edges", () => {
        expect(autoScrollStep(200, top, bottom)).toBe(0);
        expect(autoScrollStep(top + RailAutoScrollZonePx, top, bottom)).toBe(0);
    });

    it("scrolls up near the top and down near the bottom, faster nearer the edge", () => {
        expect(autoScrollStep(top + 12, top, bottom)).toBeLessThan(0);
        expect(autoScrollStep(top, top, bottom)).toBe(-RailAutoScrollMaxPx);
        expect(autoScrollStep(bottom - 12, top, bottom)).toBeGreaterThan(0);
        expect(autoScrollStep(bottom + 50, top, bottom)).toBe(RailAutoScrollMaxPx);
        expect(Math.abs(autoScrollStep(top + 20, top, bottom))).toBeLessThan(
            Math.abs(autoScrollStep(top + 2, top, bottom))
        );
    });
});

describe("railMoveKey (FR-MC-031-AC3)", () => {
    const key = (key: string, mods: Partial<KeyboardEvent> = {}) =>
        railMoveKey({ key, altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, ...mods });

    it("reads Alt+Shift+Up and Alt+Shift+Down", () => {
        expect(key("ArrowUp")).toBe(-1);
        expect(key("ArrowDown")).toBe(1);
    });

    it("ignores other keys and other modifiers", () => {
        expect(key("ArrowLeft")).toBeNull();
        expect(key("ArrowUp", { altKey: false })).toBeNull();
        expect(key("ArrowUp", { shiftKey: false })).toBeNull();
        expect(key("ArrowUp", { ctrlKey: true })).toBeNull();
        expect(key("ArrowUp", { metaKey: true })).toBeNull();
    });
});
