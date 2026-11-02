// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A view is columns of panels (FR-SHELL-086): where a panel dragged by its header, or a tab or a file dropped on a
// panel, lands. Left or right of a panel makes a new top-level column beside that panel's column; above or below
// stacks it in the panel's column. Pure rules, tested without the app; panel-move.ts carries them out on the layout.

import type { LayoutNode } from "@/layout/lib/types";
import { besideColumns } from "./add-beside-model";
import type { Rect } from "./drop-model";
import type { SplitDirection } from "./split-model";

// A new column beside the column holding the target, or a stack with the target in its column.
export type PanelPlace =
    | { kind: "column"; columnId: string; position: "before" | "after" }
    | { kind: "stack"; targetNodeId: string; position: "before" | "after" };

function contains(node: LayoutNode, nodeId: string): boolean {
    return node?.id === nodeId || (node?.children ?? []).some((child) => contains(child, nodeId));
}

function findIn(node: LayoutNode, nodeId: string): LayoutNode {
    if (node == null) {
        return null;
    }
    if (node.id === nodeId) {
        return node;
    }
    for (const child of node.children ?? []) {
        const found = findIn(child, nodeId);
        if (found != null) {
            return found;
        }
    }
    return null;
}

// The side of the panel nearest to the point: the whole panel is split between its four zones, so a panel drag always
// shows where it goes. Null outside the panel.
export function nearestSide(x: number, y: number, rect: Rect): SplitDirection {
    if (rect == null || !(rect.width > 0) || !(rect.height > 0)) {
        return null;
    }
    const fx = (x - rect.left) / rect.width;
    const fy = (y - rect.top) / rect.height;
    if (fx < 0 || fy < 0 || fx > 1 || fy > 1) {
        return null;
    }
    const sides: [SplitDirection, number][] = [
        ["left", fx],
        ["right", 1 - fx],
        ["up", fy],
        ["down", 1 - fy],
    ];
    return sides.reduce((best, side) => (side[1] < best[1] ? side : best))[0];
}

// A panel dragged by its header: the four edge zones, plus Wave's centre zone, which swaps the two panels.
export type PanelZone = SplitDirection | "center";

// The centre zone is Wave's (determineDropDirection): the middle fifth of the panel, both ways.
export const SwapZoneLow = 2 / 5;
export const SwapZoneHigh = 3 / 5;

// The zone of a panel under the point for a panel drag: the centre swaps, anywhere else the nearest side.
export function panelZoneAt(x: number, y: number, rect: Rect): PanelZone {
    const side = nearestSide(x, y, rect);
    if (side == null) {
        return null;
    }
    const fx = (x - rect.left) / rect.width;
    const fy = (y - rect.top) / rect.height;
    if (fx > SwapZoneLow && fx < SwapZoneHigh && fy > SwapZoneLow && fy < SwapZoneHigh) {
        return "center";
    }
    return side;
}

// Whether two panels can swap: both in the tree, distinct, and neither the root (a lone panel).
export function canSwap(root: LayoutNode, targetNodeId: string, movedNodeId: string): boolean {
    if (root == null || !targetNodeId || !movedNodeId || targetNodeId === movedNodeId) {
        return false;
    }
    if (root.id === targetNodeId || root.id === movedNodeId) {
        return false;
    }
    return findIn(root, targetNodeId) != null && findIn(root, movedNodeId) != null;
}

// The index of the top-level column holding the node, -1 when it is not in the tree.
export function columnIndexOfNode(root: LayoutNode, nodeId: string): number {
    if (!nodeId) {
        return -1;
    }
    return besideColumns(root).findIndex((column) => contains(column, nodeId));
}

// In 360 view nothing goes before the fixed zone's first column (#677, carpet-model.ts carpetSplitPlace): its left
// zone is its right one, the start of the carpet, so the ghost and the chip show where the panel really lands.
export function effectiveSide(side: SplitDirection, columnIndex: number, in360: boolean): SplitDirection {
    if (in360 && side === "left" && columnIndex === 0) {
        return "right";
    }
    return side;
}

// Where a panel goes for a zone of the target panel. Null when there is nothing to do (the target is the dragged panel
// itself, or either is not in the tree).
export function panelPlace(
    root: LayoutNode,
    targetNodeId: string,
    side: SplitDirection,
    movedNodeId: string = null
): PanelPlace {
    if (root == null || side == null || !targetNodeId || targetNodeId === movedNodeId) {
        return null;
    }
    if (findIn(root, targetNodeId) == null || (movedNodeId != null && findIn(root, movedNodeId) == null)) {
        return null;
    }
    const position = side === "left" || side === "up" ? "before" : "after";
    if (side === "up" || side === "down") {
        return { kind: "stack", targetNodeId, position };
    }
    const column = besideColumns(root).find((c) => contains(c, targetNodeId));
    if (column == null) {
        return null;
    }
    return { kind: "column", columnId: column.id, position };
}

// The layout sizes once a panel is placed. A new column takes the size of the column it goes beside, an equal share of
// the row; a stacked panel takes half of the target, which keeps the other half, so the other panels of the column
// keep their size.
export function placeSizes(place: PanelPlace, root: LayoutNode): { added: number; target?: number } {
    if (place == null) {
        return null;
    }
    if (place.kind === "column") {
        const column = findIn(root, place.columnId);
        return { added: column?.size ?? 10 };
    }
    const size = findIn(root, place.targetNodeId)?.size;
    const half = Number.isFinite(size) && size > 0 ? size / 2 : 5;
    return { added: half, target: half };
}

// The chip names a panel as a person would: an agent's header reads "Valentin · Claude Code", the chip "Right of
// Valentin".
export function chipName(title: string): string {
    return (title ?? "").split(" · ")[0].trim();
}

// The sizes of the children of a row or a column made equal (a double-click on the gutter between two of them).
export function equalSizes(count: number): number[] {
    if (!(count > 0)) {
        return [];
    }
    return Array.from({ length: count }, () => 100 / count);
}
