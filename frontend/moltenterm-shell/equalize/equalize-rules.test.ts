// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { FlexDirection, type LayoutNode, type ResizeNodeOperation } from "@/layout/lib/types";
import { describe, expect, it } from "vitest";
import { columnSpan, equalCarpetWidthPx, equalizeOps, hasColumnsToEqualize } from "./equalize-rules";

function leaf(id: string, size = 10): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size, data: { blockId: `b-${id}` } };
}

function row(id: string, children: LayoutNode[], size = 10): LayoutNode {
    return { id, flexDirection: FlexDirection.Row, size, children };
}

function stack(id: string, children: LayoutNode[], size = 10): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size, children };
}

function apply(root: LayoutNode, ops: ResizeNodeOperation[]): LayoutNode {
    const byId = new Map(ops.map((op) => [op.nodeId, op.size]));
    const walk = (node: LayoutNode) => {
        if (byId.has(node.id)) {
            node.size = byId.get(node.id);
        }
        node.children?.forEach(walk);
    };
    walk(root);
    return root;
}

// Each leaf's width as a share of the root's width, from the flex weights.
function widths(root: LayoutNode): Record<string, number> {
    const rtn: Record<string, number> = {};
    const walk = (node: LayoutNode, share: number) => {
        if (!node.children?.length) {
            rtn[node.id] = share;
            return;
        }
        const total = node.children.reduce((acc, c) => acc + c.size, 0);
        for (const child of node.children) {
            walk(child, node.flexDirection === FlexDirection.Row ? (share * child.size) / total : share);
        }
    };
    walk(root, 1);
    return rtn;
}

describe("columnSpan", () => {
    it("counts a panel as one column, a row as the sum, a vertical stack as its widest row", () => {
        expect(columnSpan(leaf("a"))).toBe(1);
        expect(columnSpan(row("r", [leaf("a"), leaf("b"), leaf("c")]))).toBe(3);
        expect(columnSpan(stack("s", [leaf("a"), row("r", [leaf("b"), leaf("c")])]))).toBe(2);
    });
});

describe("equalizeOps", () => {
    it("gives three uneven columns the same width", () => {
        const root = row("root", [leaf("a", 60), leaf("b", 25), leaf("c", 15)]);
        const w = widths(apply(root, equalizeOps(root)));
        expect(w.a).toBeCloseTo(1 / 3);
        expect(w.b).toBeCloseTo(1 / 3);
        expect(w.c).toBeCloseTo(1 / 3);
    });

    it("keeps the row heights of a column split vertically", () => {
        const left = stack("left", [leaf("top", 70), leaf("bottom", 30)], 80);
        const root = row("root", [left, leaf("right", 20)]);
        const ops = equalizeOps(root);
        expect(ops.map((op) => op.nodeId).sort()).toEqual(["left", "right"]);
        apply(root, ops);
        expect(left.children.map((c) => c.size)).toEqual([70, 30]);
        const w = widths(root);
        expect(w.top).toBeCloseTo(0.5);
        expect(w.right).toBeCloseTo(0.5);
    });

    it("weighs a nested row by the columns it holds, so every column gets the same width", () => {
        const nested = stack("s", [row("r", [leaf("a", 90), leaf("b", 10)], 50), leaf("c", 50)], 20);
        const root = row("root", [nested, leaf("d", 80)]);
        const w = widths(apply(root, equalizeOps(root)));
        expect(w.a).toBeCloseTo(1 / 3);
        expect(w.b).toBeCloseTo(1 / 3);
        expect(w.d).toBeCloseTo(1 / 3);
        expect(w.c).toBeCloseTo(2 / 3);
    });

    it("keeps sizes in the layout's 0-100 range and changes nothing once even", () => {
        const root = row("root", [leaf("a", 3), leaf("b", 1)]);
        const ops = equalizeOps(root);
        expect(ops.every((op) => op.size > 0 && op.size <= 100)).toBe(true);
        apply(root, ops);
        expect(equalizeOps(root)).toEqual([]);
    });

    it("in 360 view leaves the first column and the root's columns untouched and evens out the carpet's insides", () => {
        const first = row("first", [leaf("f1", 80), leaf("f2", 20)], 70);
        const carpet = row("carpet", [leaf("k1", 90), leaf("k2", 10)], 30);
        const root = row("root", [first, carpet]);
        const ops = equalizeOps(root, { keepRootChildren: true, skipNodeIds: ["first"] });
        expect(ops.map((op) => op.nodeId).sort()).toEqual(["k1", "k2"]);
        apply(root, ops);
        expect(first.size).toBe(70);
        expect(first.children.map((c) => c.size)).toEqual([80, 20]);
        expect(carpet.size).toBe(30);
        expect(carpet.children[0].size).toBeCloseTo(carpet.children[1].size);
    });

    it("has nothing to do for a single panel or a single vertical stack", () => {
        expect(equalizeOps(leaf("a"))).toEqual([]);
        expect(equalizeOps(stack("s", [leaf("a", 70), leaf("b", 30)]))).toEqual([]);
        expect(hasColumnsToEqualize(leaf("a"))).toBe(false);
        expect(hasColumnsToEqualize(stack("s", [leaf("a"), leaf("b")]))).toBe(false);
        expect(hasColumnsToEqualize(stack("s", [leaf("a"), row("r", [leaf("b"), leaf("c")])]))).toBe(true);
    });
});

describe("equalCarpetWidthPx", () => {
    it("gives the carpet's columns their mean width, null when already even or alone", () => {
        expect(equalCarpetWidthPx([640, 720, 500])).toBe(620);
        expect(equalCarpetWidthPx([640, 640.4])).toBeNull();
        expect(equalCarpetWidthPx([640])).toBeNull();
        expect(equalCarpetWidthPx([])).toBeNull();
    });
});
