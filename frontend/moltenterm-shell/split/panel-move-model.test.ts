// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { deleteNode, splitHorizontal, splitVertical } from "@/layout/lib/layoutTree";
import { FlexDirection, LayoutTreeActionType, type LayoutNode, type LayoutTreeState } from "@/layout/lib/types";
import { describe, expect, it } from "vitest";
import { columnIndexOfNode, effectiveSide, equalSizes, nearestSide, panelPlace, placeSizes } from "./panel-move-model";

function leaf(id: string, size = 10): LayoutNode {
    return { id, flexDirection: FlexDirection.Row, size, data: { blockId: `b-${id}` } } as LayoutNode;
}

function group(id: string, dir: FlexDirection, children: LayoutNode[], size = 10): LayoutNode {
    return { id, flexDirection: dir, size, children } as LayoutNode;
}

// Two columns: a terminal on the left, Project stacked over Pilotage on the right.
function twoColumns(): LayoutNode {
    return group("root", FlexDirection.Row, [
        leaf("term", 20),
        group("col2", FlexDirection.Column, [leaf("project", 10), leaf("pilotage", 10)], 20),
    ]);
}

function shape(node: LayoutNode): string {
    if (!node.children?.length) {
        return node.id;
    }
    const dir = node.flexDirection === FlexDirection.Row ? "row" : "col";
    return `${dir}(${node.children.map(shape).join(",")})`;
}

// What panel-move.ts does on the layout: the panel leaves, then is split in at its place.
function applyMove(root: LayoutNode, movedId: string, targetId: string, side: "left" | "right" | "up" | "down") {
    const state = { rootNode: root } as LayoutTreeState;
    const place = panelPlace(root, targetId, side, movedId);
    const find = (n: LayoutNode, id: string): LayoutNode =>
        n.id === id ? n : (n.children ?? []).map((c) => find(c, id)).find((x) => x != null);
    const moved = find(root, movedId);
    deleteNode(state, { type: LayoutTreeActionType.DeleteNode, nodeId: movedId });
    const action = {
        targetNodeId: place.kind === "column" ? place.columnId : place.targetNodeId,
        newNode: moved,
        position: place.position,
    };
    if (place.kind === "column") {
        splitHorizontal(state, { type: LayoutTreeActionType.SplitHorizontal, ...action });
    } else {
        splitVertical(state, { type: LayoutTreeActionType.SplitVertical, ...action });
    }
    return state.rootNode;
}

describe("nearestSide (FR-SHELL-086: four zones)", () => {
    const rect = { left: 100, top: 100, width: 400, height: 200 };

    it.each([
        [110, 200, "left"],
        [490, 200, "right"],
        [300, 105, "up"],
        [300, 295, "down"],
        [300, 150, "up"],
        [150, 290, "down"],
    ])("(%i, %i) is the %s zone", (x, y, side) => {
        expect(nearestSide(x, y, rect)).toBe(side);
    });

    it("gives no zone outside the panel or for an empty rect", () => {
        expect(nearestSide(50, 200, rect)).toBeNull();
        expect(nearestSide(300, 301, rect)).toBeNull();
        expect(nearestSide(10, 10, { left: 0, top: 0, width: 0, height: 10 })).toBeNull();
    });
});

describe("panelPlace", () => {
    it("left or right of a stacked panel makes a new column beside its column", () => {
        const root = twoColumns();
        expect(panelPlace(root, "pilotage", "left", "term")).toEqual({
            kind: "column",
            columnId: "col2",
            position: "before",
        });
        expect(panelPlace(root, "project", "right")).toEqual({ kind: "column", columnId: "col2", position: "after" });
    });

    it("above or below stacks the panel in the target's column", () => {
        const root = twoColumns();
        expect(panelPlace(root, "pilotage", "down", "term")).toEqual({
            kind: "stack",
            targetNodeId: "pilotage",
            position: "after",
        });
        expect(panelPlace(root, "term", "up")).toEqual({ kind: "stack", targetNodeId: "term", position: "before" });
    });

    it("a single column (or a lone panel) is its own column", () => {
        const root = group("root", FlexDirection.Column, [leaf("a"), leaf("b")]);
        expect(panelPlace(root, "b", "right", "a")).toEqual({ kind: "column", columnId: "root", position: "after" });
    });

    it("does nothing on the dragged panel itself or a panel out of the tree", () => {
        const root = twoColumns();
        expect(panelPlace(root, "term", "left", "term")).toBeNull();
        expect(panelPlace(root, "nope", "left", "term")).toBeNull();
        expect(panelPlace(root, "term", "left", "nope")).toBeNull();
        expect(panelPlace(root, "term", null, "project")).toBeNull();
    });
});

describe("a panel moved on the layout tree", () => {
    it("left of a stacked panel: a new column between the others", () => {
        expect(shape(applyMove(twoColumns(), "pilotage", "project", "left"))).toBe("row(term,pilotage,col(project))");
    });

    it("right of the terminal: the stacked panel leaves its column for a new one", () => {
        expect(shape(applyMove(twoColumns(), "project", "term", "right"))).toBe("row(term,project,col(pilotage))");
    });

    it("below the terminal: stacked in the terminal's column", () => {
        expect(shape(applyMove(twoColumns(), "pilotage", "term", "down"))).toBe("row(col(term,pilotage),col(project))");
    });

    it("above a panel of the same column: reordered in it", () => {
        expect(shape(applyMove(twoColumns(), "pilotage", "project", "up"))).toBe("row(term,col(pilotage,project))");
    });

    it("right of a single stack: the tree becomes a row of columns", () => {
        const root = group("root", FlexDirection.Column, [leaf("a"), leaf("b"), leaf("c")]);
        expect(shape(applyMove(root, "c", "a", "right"))).toBe("row(col(a,b),c)");
    });
});

describe("placeSizes", () => {
    it("a new column takes the size of the column it goes beside", () => {
        const root = twoColumns();
        expect(placeSizes({ kind: "column", columnId: "col2", position: "after" }, root)).toEqual({ added: 20 });
    });

    it("a stacked panel takes half of the target, which keeps the other half", () => {
        const root = twoColumns();
        expect(placeSizes({ kind: "stack", targetNodeId: "project", position: "after" }, root)).toEqual({
            added: 5,
            target: 5,
        });
    });
});

describe("the 360 view's fixed column", () => {
    it("takes nothing on its left: its left zone is the start of the carpet", () => {
        expect(effectiveSide("left", 0, true)).toBe("right");
        expect(effectiveSide("left", 1, true)).toBe("left");
        expect(effectiveSide("left", 0, false)).toBe("left");
        expect(effectiveSide("up", 0, true)).toBe("up");
    });

    it("finds the column of a panel", () => {
        const root = twoColumns();
        expect(columnIndexOfNode(root, "term")).toBe(0);
        expect(columnIndexOfNode(root, "pilotage")).toBe(1);
        expect(columnIndexOfNode(root, "nope")).toBe(-1);
    });
});

describe("equalSizes (double-click on a gutter)", () => {
    it("shares the row or column evenly", () => {
        expect(equalSizes(4)).toEqual([25, 25, 25, 25]);
        expect(equalSizes(0)).toEqual([]);
    });
});
