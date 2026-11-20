// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Equalize panels (#825): the rules, kept apart from the layout so they are tested alone. Every panel column of a tab
// gets the same width; a column split vertically keeps its row heights. Sizes are flex weights, so a resize only gives
// each child of a row a weight in proportion to the columns it holds.

import { FlexDirection, type LayoutNode, type ResizeNodeOperation } from "@/layout/lib/types";
import { sharedColumnSizes } from "../view360/view360-decision";

// Wave's resize refuses sizes over 100: the children of a row share this total.
const RowTotal = 100;
// Two sizes closer than this are equal: a pass that would only round them changes nothing.
const SizeEpsilon = 0.01;

function isRow(node: LayoutNode): boolean {
    return node?.flexDirection === FlexDirection.Row;
}

// The panel columns a node spans side by side: a panel is one, a row the sum of its children, a vertical stack its
// widest child (its rows share its width).
export function columnSpan(node: LayoutNode): number {
    if (node == null) {
        return 0;
    }
    if (!node.children?.length) {
        return 1;
    }
    const spans = node.children.map(columnSpan);
    if (isRow(node)) {
        return spans.reduce((acc, n) => acc + n, 0);
    }
    return Math.max(...spans);
}

// Whether the node has two panels side by side somewhere (the button has nothing to do otherwise).
export function hasColumnsToEqualize(node: LayoutNode): boolean {
    if (!node?.children?.length) {
        return false;
    }
    if (isRow(node) && node.children.length > 1) {
        return true;
    }
    return node.children.some(hasColumnsToEqualize);
}

export type EqualizeOptions = {
    // The root's own children keep their sizes (in 360 view the carpet layout sizes them, not the tree).
    keepRootChildren?: boolean;
    // Subtrees left exactly as they are (the 360 view's fixed zone).
    skipNodeIds?: string[];
};

// The resize operations that make every panel column the same width; empty when the tree is already even.
export function equalizeOps(root: LayoutNode, opts?: EqualizeOptions): ResizeNodeOperation[] {
    const ops: ResizeNodeOperation[] = [];
    if (root == null) {
        return ops;
    }
    const skip = new Set(opts?.skipNodeIds ?? []);
    const visit = (node: LayoutNode, isRoot: boolean) => {
        if (skip.has(node.id) || !node.children?.length) {
            return;
        }
        const sizeChildren = isRow(node) && node.children.length > 1 && !(isRoot && opts?.keepRootChildren);
        if (sizeChildren) {
            const spans = node.children.map(columnSpan);
            const total = spans.reduce((acc, n) => acc + n, 0);
            node.children.forEach((child, i) => {
                const size = (RowTotal * spans[i]) / total;
                if (Math.abs((child.size ?? 0) - size) > SizeEpsilon) {
                    ops.push({ nodeId: child.id, size });
                }
            });
        }
        node.children.forEach((child) => visit(child, false));
    };
    visit(root, true);
    return ops;
}

function parentOf(node: LayoutNode, nodeId: string): LayoutNode {
    for (const child of node?.children ?? []) {
        if (child.id === nodeId) {
            return node;
        }
        const found = parentOf(child, nodeId);
        if (found != null) {
            return found;
        }
    }
    return null;
}

function evenOps(children: LayoutNode[], weights: number[]): ResizeNodeOperation[] {
    const total = weights.reduce((acc, n) => acc + n, 0);
    const ops: ResizeNodeOperation[] = [];
    children.forEach((child, i) => {
        const size = (RowTotal * weights[i]) / total;
        if (Math.abs((child.size ?? 0) - size) > SizeEpsilon) {
            ops.push({ nodeId: child.id, size });
        }
    });
    return ops;
}

// What the top-level columns keep when a panel is added (FR-SHELL-042 AC-grid, #2433): the tab's width and the width
// each column keeps at least, which is the first column's floor (#848) and nothing for the others.
export type AddedPanelFloor = { parentId: string; minsPx: number[]; widthPx: number; gapPx: number };

// The sizes of a panel just added (#1241, #2433): the siblings it joined share their axis equally, the new one included:
// a row by the columns each spans, a column's rows alike, nothing inside them touched, so a stacked column keeps its
// heights and the other rows keep their widths. A row of top-level columns whose equal parts would put the first
// column under its floor shares the width as "Readjust every size" does, so the floor holds and the 360 view takes over
// when the columns do not fit. Empty when the node has no sibling, or all are even.
export function addedPanelOps(root: LayoutNode, nodeId: string, floor?: AddedPanelFloor): ResizeNodeOperation[] {
    const parent = parentOf(root, nodeId);
    if (parent == null || (parent.children?.length ?? 0) < 2) {
        return [];
    }
    const children = parent.children;
    if (!isRow(parent)) {
        return evenOps(
            children,
            children.map(() => 1)
        );
    }
    const spans = children.map(columnSpan);
    if (floor?.parentId !== parent.id || floor.minsPx?.length !== children.length || !(floor.widthPx > 0)) {
        return evenOps(children, spans);
    }
    const total = spans.reduce((acc, n) => acc + n, 0);
    const room = floor.widthPx - Math.max(0, floor.gapPx || 0) * (children.length - 1);
    const tight = children.some((_, i) => (spans[i] / total) * room + 0.5 < floor.minsPx[i]);
    if (!tight) {
        return evenOps(children, spans);
    }
    const sizes = sharedColumnSizes(floor.minsPx, floor.widthPx, floor.gapPx);
    return children.flatMap((child, i) =>
        Math.abs((child.size ?? 0) - sizes[i]) > SizeEpsilon ? [{ nodeId: child.id, size: sizes[i] }] : []
    );
}
