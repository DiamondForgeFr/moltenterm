// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Add a panel on the left / on the right" (#732): a new top-level column beside the column holding a panel, never a
// split of it, so the panels already there keep their size. Pure rules (where the column goes, whether it fits without
// the 360 view and the sizes it then gives), kept apart from the layout so they are tested alone.

import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { type CarpetLayout, carpetInsertPlace } from "../view360/carpet-model";
import { columnMinPx, columnsParent } from "../view360/view360-decision";

export type BesideSide = "left" | "right";

// columnSizes: the top-level columns' sizes once the new one is in (besideFit), when the tab stays in the normal layout.
export type ColumnPlace = { targetNodeId: string; position: "before" | "after"; columnSizes?: number[] };

// A top-level column as the fit sees it: its width in the normal layout, the width its terminals need under the
// terminal floor (#731), and the width it would take on the carpet.
export type BesideColumn = { px: number; needPx: number; carpetPx: number };

function contains(node: LayoutNode, nodeId: string): boolean {
    return node?.id === nodeId || (node?.children ?? []).some((child) => contains(child, nodeId));
}

// The node whose children are the top-level columns' (the tree itself for a single column), and those columns.
export function besideColumns(root: LayoutNode): LayoutNode[] {
    if (root == null) {
        return [];
    }
    const parent = columnsParent(root);
    return parent == null ? [root] : parent.children;
}

// The index of the top-level column holding the node, -1 when it is not in the tree.
export function columnIndexOf(root: LayoutNode, nodeId: string): number {
    if (!nodeId) {
        return -1;
    }
    return besideColumns(root).findIndex((column) => contains(column, nodeId));
}

function positionOf(side: BesideSide): "before" | "after" {
    return side === "left" ? "before" : "after";
}

// The fixed zone's column holding the node in 360 view (the first column or a pinned one), null when it is on the
// carpet or the tab is not drawn in 360 view.
function fixedColumnOf(root: LayoutNode, layout: CarpetLayout, nodeId: string): string {
    if (layout == null || root == null) {
        return null;
    }
    const fixed = (layout.fixedColumns ?? []).find((column) => {
        const node = findChild(root, column.nodeId);
        return node != null && contains(node, nodeId);
    });
    return fixed?.nodeId ?? null;
}

function findChild(root: LayoutNode, nodeId: string): LayoutNode {
    if (root?.id === nodeId) {
        return root;
    }
    for (const child of root?.children ?? []) {
        const found = findChild(child, nodeId);
        if (found != null) {
            return found;
        }
    }
    return null;
}

// Where the new column goes. In the normal layout, right before or after the top-level column holding the panel. In
// 360 view (layout set), beside a carpet column the same; beside the fixed zone only on the right, which is the start
// of the carpet (the carpet's left "+", #702); nothing goes before the fixed zone. Null when there is no place.
export function besidePlace(root: LayoutNode, nodeId: string, side: BesideSide, layout: CarpetLayout): ColumnPlace {
    if (root == null || !contains(root, nodeId)) {
        return null;
    }
    if (layout != null) {
        if (fixedColumnOf(root, layout, nodeId) != null) {
            return side === "right" ? carpetInsertPlace(root, layout, "start") : null;
        }
        if (root.flexDirection === FlexDirection.Row && root.children?.length) {
            const column = root.children.find((child) => contains(child, nodeId));
            if (column != null) {
                return { targetNodeId: column.id, position: positionOf(side) };
            }
        }
    }
    const columns = besideColumns(root);
    const column = columns.find((c) => contains(c, nodeId));
    return column == null ? null : { targetNodeId: column.id, position: positionOf(side) };
}

// The width a column keeps when one is added beside it: its current width, but no more than it would have on the
// carpet, and never under its minimum (the readable minimum of its place, or what its terminals need).
export function keptColumnPx(column: BesideColumn, minPx: number): number {
    return Math.max(minPx, Math.min(column.px, column.carpetPx));
}

// The columns' sizes (percent of the row, the new column at insertIndex) when a new column asking for newPx fits
// beside the others without taking any of them under the width it keeps; null when it does not fit, the tab then
// goes to 360 view. The new column takes an equal share of the row when the room allows it, its ask at least; the
// others give what is above the width they keep, in proportion.
export function besideFit(
    columns: BesideColumn[],
    insertIndex: number,
    newPx: number,
    widthPx: number,
    gapPx = 0
): number[] {
    const count = columns?.length ?? 0;
    if (count === 0 || !(widthPx > 0) || insertIndex < 0 || insertIndex > count) {
        return null;
    }
    const gap = Math.max(0, gapPx || 0);
    const want = Math.max(newPx > 0 ? newPx : 0, columnMinPx(insertIndex));
    const slacks = columns.map((column, i) => {
        const index = i < insertIndex ? i : i + 1;
        const minPx = Math.max(columnMinPx(index), column.needPx > 0 ? column.needPx : 0);
        return Math.max(0, column.px - keptColumnPx(column, minPx));
    });
    const slack = slacks.reduce((acc, s) => acc + s, 0);
    if (slack < want + gap) {
        return null;
    }
    const roomAfter = widthPx - gap * count;
    const addedPx = Math.min(Math.max(want, roomAfter / (count + 1)), slack - gap);
    const taken = addedPx + gap;
    const pxs = columns.map((column, i) => column.px - (taken * slacks[i]) / slack);
    pxs.splice(insertIndex, 0, addedPx);
    return pxs.map((px) => (px / roomAfter) * 100);
}

// The index the new column takes among the top-level columns.
export function insertIndexFor(columnIndex: number, side: BesideSide): number {
    return side === "left" ? columnIndex : columnIndex + 1;
}
