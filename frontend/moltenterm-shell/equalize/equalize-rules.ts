// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Equalize panels (#825): the rules, kept apart from the layout so they are tested alone. Every panel column of a tab
// gets the same width; a column split vertically keeps its row heights. Sizes are flex weights, so a resize only gives
// each child of a row a weight in proportion to the columns it holds.

import { FlexDirection, type LayoutNode, type ResizeNodeOperation } from "@/layout/lib/types";

// Wave's resize refuses sizes over 100: the children of a row share this total.
const RowTotal = 100;
// Two sizes closer than this are equal: a pass that would only round them changes nothing.
const SizeEpsilon = 0.01;
const PxEpsilon = 1;

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

// The width every carpet column takes in 360 view: the mean of their widths now, so the carpet keeps its length.
// Null when the carpet has fewer than two columns or they are already even.
export function equalCarpetWidthPx(widthsPx: number[]): number {
    const widths = (widthsPx ?? []).filter((px) => Number.isFinite(px) && px > 0);
    if (widths.length < 2) {
        return null;
    }
    const min = Math.min(...widths);
    const max = Math.max(...widths);
    if (max - min <= PxEpsilon) {
        return null;
    }
    return Math.round(widths.reduce((acc, px) => acc + px, 0) / widths.length);
}
