// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { CarpetEdgePx, computeCarpetLayout } from "./carpet-model";
import {
    captureProbePoints,
    captureTargets,
    carpetEndOfSide,
    endSlotRect,
    endSlotSides,
    endSlotsShown,
    overlapsCapture,
    peekNeighbours,
    peekRect,
    PeekWidthPx,
} from "./carpet-peeks";

const ticks = (visible: boolean[]) => visible.map((v, i) => ({ columnId: `c${i}`, visible: v }));

describe("edge peeks (FR-SHELL-065 AC11)", () => {
    it("shows the panel just before and just after the ones in view", () => {
        const { left, right } = peekNeighbours(ticks([false, false, true, true, false, false]));
        expect(left?.columnId).toBe("c1");
        expect(right?.columnId).toBe("c4");
    });

    it("shows no peek at an end of the carpet", () => {
        expect(peekNeighbours(ticks([true, true, false]))).toEqual({
            left: null,
            right: { columnId: "c2", visible: false },
        });
        expect(peekNeighbours(ticks([false, true, true]))).toEqual({
            left: { columnId: "c0", visible: false },
            right: null,
        });
        expect(peekNeighbours(ticks([true, true]))).toEqual({ left: null, right: null });
        expect(peekNeighbours(ticks([]))).toEqual({ left: null, right: null });
    });

    const layout = computeCarpetLayout({
        width: 1600,
        height: 900,
        fixedNodeId: "term",
        fixedPx: 600,
        columns: [
            { nodeId: "a", widthPx: 484 },
            { nodeId: "b", widthPx: 484 },
            { nodeId: "c", widthPx: 484 },
        ],
    });

    it("draws each peek inside its gutter, on the places' side, shorter than the panels", () => {
        const v = layout.viewport;
        const left = peekRect(layout, "left", 4);
        const right = peekRect(layout, "right", 4);
        expect(left.width).toBe(PeekWidthPx);
        expect(left.left + left.width).toBe(v.left);
        expect(left.left).toBeGreaterThanOrEqual(v.left - CarpetEdgePx);
        expect(right.left).toBe(v.left + v.width);
        expect(right.left + right.width).toBeLessThanOrEqual(1600 - 4);
        expect(left.top).toBeGreaterThan(v.top + 4);
        expect(left.top + left.height).toBeLessThan(v.top + v.height - 4);
    });

    it("captures only the columns whole in view, inset to the panel, in the window's coordinates", () => {
        const at0 = captureTargets(layout, 0, { x: 100, y: 50 }, 4);
        expect(at0.map((t) => t.columnId)).toEqual(["a", "b"]);
        expect(at0[0].rect).toEqual({
            x: 100 + layout.viewport.left + 4,
            y: 50 + 4,
            width: 484 - 8,
            height: layout.viewport.height - 8,
        });
        // Half-way through a panel, the one cut at the edge is not captured.
        expect(captureTargets(layout, 242, { x: 0, y: 0 }, 4).map((t) => t.columnId)).toEqual(["b"]);
        expect(captureTargets(null, 0, { x: 0, y: 0 }, 4)).toEqual([]);
    });

    it("probes a column at its centre and near its corners", () => {
        const points = captureProbePoints({ x: 10, y: 20, width: 400, height: 600 });
        expect(points[0]).toEqual({ x: 210, y: 320 });
        expect(points).toHaveLength(5);
        for (const p of points) {
            expect(p.x).toBeGreaterThan(10);
            expect(p.x).toBeLessThan(410);
            expect(p.y).toBeGreaterThan(20);
            expect(p.y).toBeLessThan(620);
        }
    });

    it("sees a floating card over any part of a column, not only over a probe point (#1814)", () => {
        const column = { x: 100, y: 0, width: 400, height: 1000 };
        const card = (left: number, top: number, w: number, h: number) => ({
            left,
            top,
            right: left + w,
            bottom: top + h,
        });
        // A preview card over the lower middle of the column misses the centre and the four corner probes.
        const probes = captureProbePoints(column);
        const lowerMiddle = card(200, 800, 200, 190);
        expect(probes.some((p) => p.x >= 200 && p.x <= 400 && p.y >= 800 && p.y <= 990)).toBe(false);
        expect(overlapsCapture(lowerMiddle, column)).toBe(true);
        expect(overlapsCapture(card(500, 0, 100, 100), column)).toBe(false);
        expect(overlapsCapture(card(0, 0, 100, 100), column)).toBe(false);
        expect(overlapsCapture(card(0, 1000, 600, 40), column)).toBe(false);
        expect(overlapsCapture(card(120, 990, 50, 50), column)).toBe(true);
        expect(overlapsCapture(card(150, 100, 0, 0), column)).toBe(false);
    });
});

describe("add-panel slots at the ends of the carpet (#1836, FR-SHELL-065 AC15)", () => {
    const layout = computeCarpetLayout({
        width: 1600,
        height: 900,
        fixedNodeId: "term",
        fixedPx: 600,
        columns: [
            { nodeId: "a", widthPx: 484 },
            { nodeId: "b", widthPx: 484 },
            { nodeId: "c", widthPx: 484 },
        ],
    });

    it("fills the start and the end of the carpet, where no peek exists", () => {
        expect(endSlotSides(ticks([true, true, false, false]))).toEqual(["left"]);
        expect(endSlotSides(ticks([false, false, true, true]))).toEqual(["right"]);
        expect(endSlotSides(ticks([true, true, true]))).toEqual(["left", "right"]);
        expect(endSlotSides(ticks([true]))).toEqual(["left", "right"]);
    });

    it("leaves a gutter that holds a peek to the peek", () => {
        expect(endSlotSides(ticks([false, true, true, false]))).toEqual([]);
        expect(endSlotSides(ticks([false, true, false]))).toEqual([]);
    });

    it("draws nothing for a carpet with nothing in view or no panel", () => {
        expect(endSlotSides(ticks([false, false]))).toEqual([]);
        expect(endSlotSides(ticks([]))).toEqual([]);
        expect(endSlotSides(null)).toEqual([]);
    });

    it("never shows a slot and a peek on the same side", () => {
        for (let n = 1; n <= 5; n++) {
            for (let first = 0; first < n; first++) {
                for (let last = first; last < n; last++) {
                    const visible = Array.from({ length: n }, (_, i) => i >= first && i <= last);
                    const { left, right } = peekNeighbours(ticks(visible));
                    const sides = endSlotSides(ticks(visible));
                    expect(sides.includes("left")).toBe(left == null);
                    expect(sides.includes("right")).toBe(right == null);
                }
            }
        }
    });

    it("steps aside while a panel is magnified or dragged", () => {
        expect(endSlotsShown(null, false)).toBe(true);
        expect(endSlotsShown("node-1", false)).toBe(false);
        expect(endSlotsShown(null, true)).toBe(false);
        expect(endSlotsShown("node-1", true)).toBe(false);
    });

    it("adds at the start from the left slot and at the end from the right one", () => {
        expect(carpetEndOfSide("left")).toBe("start");
        expect(carpetEndOfSide("right")).toBe("end");
    });

    it("sits in the peek's column of the gutter, as tall as the panels beside it, never over one", () => {
        const v = layout.viewport;
        const halfGap = 4;
        for (const side of ["left", "right"] as const) {
            const slot = endSlotRect(layout, side, halfGap);
            const peek = peekRect(layout, side, halfGap);
            expect(slot.left).toBe(peek.left);
            expect(slot.width).toBe(PeekWidthPx);
            expect(slot.top).toBe(v.top + halfGap);
            expect(slot.height).toBe(v.height - 2 * halfGap);
        }
        const left = endSlotRect(layout, "left", halfGap);
        const right = endSlotRect(layout, "right", halfGap);
        expect(left.left).toBeGreaterThanOrEqual(layout.surface.left);
        expect(left.left + left.width).toBeLessThanOrEqual(v.left);
        expect(right.left).toBeGreaterThanOrEqual(v.left + v.width);
        expect(right.left + right.width).toBeLessThanOrEqual(layout.surface.left + layout.surface.width);
    });
});
