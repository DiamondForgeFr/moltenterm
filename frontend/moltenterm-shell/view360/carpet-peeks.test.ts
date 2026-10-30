// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { CarpetEdgePx, computeCarpetLayout } from "./carpet-model";
import { captureProbePoints, captureTargets, peekNeighbours, peekRect, PeekWidthPx } from "./carpet-peeks";

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
});
