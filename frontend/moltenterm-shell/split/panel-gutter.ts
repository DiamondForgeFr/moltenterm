// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The gutter between panels (FR-SHELL-086): an Arc-like pill (panel-gutter.css) that resizes the panels on either side
// when dragged and gives them equal sizes on a double-click.

import type { LayoutModel } from "@/layout/lib/layoutModel";
import { findNode } from "@/layout/lib/layoutNode";
import {
    FlexDirection,
    LayoutTreeActionType,
    type LayoutTreeResizeNodeAction,
    type ResizeHandleProps,
} from "@/layout/lib/types";
import "./panel-gutter.css";
import { equalSizes } from "./panel-move-model";

// A row's gutter sits between columns, a column's between stacked panels.
export function gutterTitleKey(flexDirection: string): string {
    return flexDirection === FlexDirection.Row ? "split.gutter.columns" : "split.gutter.rows";
}

// Every child of the row or column the gutter divides gets the same size. In 360 view the top-level columns have
// widths of their own: the equalize model evens them out (the fixed zone keeps its width).
export function resetGutterSizes(layoutModel: LayoutModel, handle: ResizeHandleProps): void {
    const root = layoutModel?.treeState?.rootNode;
    if (root == null || handle?.stuckTitleKey != null) {
        return;
    }
    if (handle.parentNodeId === root.id && layoutModel.moltenView360?.layout != null) {
        layoutModel.moltenEqualize?.equalize();
        return;
    }
    const parent = findNode(root, handle.parentNodeId);
    const children = parent?.children ?? [];
    if (children.length < 2) {
        return;
    }
    const sizes = equalSizes(children.length);
    layoutModel.treeReducer({
        type: LayoutTreeActionType.ResizeNode,
        resizeOperations: children.map((child, i) => ({ nodeId: child.id, size: sizes[i] })),
    } as LayoutTreeResizeNodeAction);
}
