// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { describe, expect, it } from "vitest";
import type { CarpetLayout } from "../view360/carpet-model";
import { FirstColumnMinPx, SideColumnMinPx } from "../view360/view360-decision";
import {
    type BesideColumn,
    besideColumns,
    besideFit,
    besidePlace,
    columnIndexOf,
    insertIndexFor,
    keptColumnPx,
} from "./add-beside-model";

function leaf(id: string, size = 10): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size, data: { blockId: `b-${id}` } };
}

function node(id: string, dir: FlexDirection, ...children: LayoutNode[]): LayoutNode {
    return { id, flexDirection: dir, size: 10, children };
}

// The tab in 360 view: "a" in the fixed zone, "p" pinned beside it, "b" and "c" on the carpet.
function layout360(fixed: string[], carpet: string[]): CarpetLayout {
    return {
        fixedNodeId: fixed[0],
        fixedColumns: fixed.map((nodeId, i) => ({
            nodeId,
            mode: i === 0 ? "first" : "beside",
            rect: { top: 0, left: 0, width: 0, height: 0 },
        })),
        columns: carpet.map((nodeId, i) => ({ nodeId, x: i * 100, width: 100 })),
    } as CarpetLayout;
}

describe("where the new column goes (#732)", () => {
    const stack = node("stack", FlexDirection.Column, leaf("b1"), leaf("b2"));
    const tree = node("root", FlexDirection.Row, leaf("a"), stack, leaf("c"));

    it("goes before or after the top-level column holding the panel, a vertical stack as a whole", () => {
        expect(besidePlace(tree, "a", "right", null)).toEqual({ targetNodeId: "a", position: "after" });
        expect(besidePlace(tree, "b2", "left", null)).toEqual({ targetNodeId: "stack", position: "before" });
        expect(besidePlace(tree, "b1", "right", null)).toEqual({ targetNodeId: "stack", position: "after" });
        expect(columnIndexOf(tree, "b2")).toBe(1);
        expect(insertIndexFor(1, "left")).toBe(1);
        expect(insertIndexFor(1, "right")).toBe(2);
    });

    it("beside a single column, the column is the whole tree; wrappers are looked through", () => {
        const single = node("root", FlexDirection.Column, leaf("x"), leaf("y"));
        expect(besidePlace(single, "y", "left", null)).toEqual({ targetNodeId: "root", position: "before" });
        expect(besideColumns(single).map((c) => c.id)).toEqual(["root"]);
        const wrapped = node("w", FlexDirection.Column, node("r", FlexDirection.Row, leaf("a"), leaf("b")));
        expect(besidePlace(wrapped, "b", "right", null)).toEqual({ targetNodeId: "b", position: "after" });
        expect(besideColumns(wrapped).map((c) => c.id)).toEqual(["a", "b"]);
    });

    it("has no place for a panel outside the tree", () => {
        expect(besidePlace(tree, "zz", "left", null)).toBe(null);
        expect(columnIndexOf(tree, "zz")).toBe(-1);
    });

    it("in 360 view, goes on the carpet beside a carpet column", () => {
        const layout = layout360(["a"], ["stack", "c"]);
        expect(besidePlace(tree, "b1", "left", layout)).toEqual({ targetNodeId: "stack", position: "before" });
        expect(besidePlace(tree, "c", "right", layout)).toEqual({ targetNodeId: "c", position: "after" });
    });

    it("in 360 view, beside the fixed zone only on the right, at the start of the carpet", () => {
        const pinned = node("root", FlexDirection.Row, leaf("a"), leaf("b"), leaf("p"), leaf("c"));
        const layout = layout360(["a", "p"], ["b", "c"]);
        expect(besidePlace(pinned, "a", "left", layout)).toBe(null);
        expect(besidePlace(pinned, "p", "left", layout)).toBe(null);
        expect(besidePlace(pinned, "a", "right", layout)).toEqual({ targetNodeId: "b", position: "before" });
        expect(besidePlace(pinned, "p", "right", layout)).toEqual({ targetNodeId: "b", position: "before" });
    });
});

describe("whether the new column fits without the 360 view (#732)", () => {
    const term = (px: number, needPx = 0): BesideColumn => ({ px, needPx, carpetPx: 640 });

    it("a column keeps its width up to its carpet width, never under its minimum", () => {
        expect(keptColumnPx(term(900), 360)).toBe(640);
        expect(keptColumnPx(term(500), 360)).toBe(500);
        expect(keptColumnPx(term(300), 360)).toBe(360);
        expect(keptColumnPx(term(900, 800), 800)).toBe(800);
    });

    it("two terminals side by side on a laptop window do not leave room: 360 view", () => {
        expect(besideFit([term(716), term(716)], 2, 560, 1440, 8)).toBe(null);
        expect(besideFit([term(716), term(716)], 1, 560, 1440, 8)).toBe(null);
    });

    it("one panel in a wide window: the column is added, the panel keeps at least its kept width", () => {
        const sizes = besideFit([term(1440)], 1, 560, 1440, 8);
        expect(sizes).toHaveLength(2);
        expect(sizes[0] + sizes[1]).toBeCloseTo(100);
        const room = 1440 - 8;
        expect((sizes[0] / 100) * room).toBeGreaterThanOrEqual(640);
        expect((sizes[1] / 100) * room).toBeCloseTo(716);
    });

    it("the new column asks for its carpet width when an equal share is less, within the room left", () => {
        const sizes = besideFit([term(1000), term(1000)], 2, 560, 2008, 8);
        const room = 2008 - 16;
        const pxs = sizes.map((s) => (s / 100) * room);
        expect(pxs[2]).toBeCloseTo(664);
        expect(pxs[0]).toBeGreaterThanOrEqual(640);
        expect(pxs[1]).toBeGreaterThanOrEqual(640);
    });

    it("takes only what is above each column's kept width, in proportion", () => {
        const sizes = besideFit([term(1200), term(800)], 2, 560, 2008, 8);
        const room = 2008 - 16;
        const pxs = sizes.map((s) => (s / 100) * room);
        // Slacks 560 and 160: the first gives 3.5 times more.
        expect((1200 - pxs[0]) / (800 - pxs[1])).toBeCloseTo(3.5);
        expect(pxs.reduce((a, b) => a + b, 0)).toBeCloseTo(room);
    });

    it("the terminal floor counts: a terminal held at its floor gives nothing", () => {
        expect(besideFit([term(1440, 1200)], 1, 560, 1440, 8)).toBe(null);
        expect(besideFit([term(2400, 1200)], 1, 560, 2400, 8)).not.toBe(null);
    });

    it("a new first column asks for the first column's minimum; the old first one then counts as a side column", () => {
        const sizes = besideFit([{ px: 1600, needPx: 0, carpetPx: 300 }], 0, 100, 1600, 0);
        expect(sizes).not.toBe(null);
        expect((sizes[0] / 100) * 1600).toBeGreaterThanOrEqual(FirstColumnMinPx);
        expect((sizes[1] / 100) * 1600).toBeGreaterThanOrEqual(SideColumnMinPx);
    });

    it("refuses odd inputs", () => {
        expect(besideFit([], 0, 560, 1440)).toBe(null);
        expect(besideFit([term(1440)], 3, 560, 1440)).toBe(null);
        expect(besideFit([term(1440)], 1, 560, 0)).toBe(null);
    });
});
