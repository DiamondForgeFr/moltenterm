// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// One rule for every panel that is added (FR-SHELL-042 AC-grid, FR-SHELL-123 AC17, #2433). Every way of adding a panel
// ends in LayoutModel.treeReducer: the new-panel key, the "+" buttons, the splits, the palette, a page opened as a
// panel, what an agent opens, a drop from another tab, a reopened panel, and the actions the backend queues. The
// reducer asks the 360 view how the panel is laid (addMode) and, in the normal layout, calls rebalanceAddedPanel
// once the tree has its new node: the panel takes the focus where the action says so and its siblings share their axis
// equally. Under a 360 × N the 360 view inserts it next to the focused panel (View360Model.rewriteAction).

import type { LayoutModel } from "@/layout/lib/layoutModel";
import { resizeNode } from "@/layout/lib/layoutTree";
import {
    DefaultNodeSize,
    LayoutTreeActionType,
    type LayoutNode,
    type LayoutTreeAction,
    type LayoutTreeInsertNodeAction,
    type LayoutTreeInsertNodeAtIndexAction,
    type LayoutTreeResizeNodeAction,
    type LayoutTreeSplitHorizontalAction,
    type LayoutTreeSplitVerticalAction,
} from "@/layout/lib/types";
import { addedPanelOps, type AddedPanelFloor } from "../equalize/equalize-rules";
import { currentFirstColumnFloorPx } from "../panel-size/panel-size-store";
import { columnMinimumsPx, columnsParent } from "../view360/view360-decision";

// The node an action adds to the tree, null for every other action.
export function addedPanelNode(action: LayoutTreeAction): LayoutNode {
    switch (action?.type) {
        case LayoutTreeActionType.InsertNode:
        case LayoutTreeActionType.InsertNodeAtIndex:
            return (action as LayoutTreeInsertNodeAction | LayoutTreeInsertNodeAtIndexAction).node ?? null;
        case LayoutTreeActionType.SplitHorizontal:
        case LayoutTreeActionType.SplitVertical:
            return (action as LayoutTreeSplitHorizontalAction | LayoutTreeSplitVerticalAction).newNode ?? null;
        default:
            return null;
    }
}

// Whether the action adds a panel that opens over the others: a magnified one hides the row, which keeps its sizes.
export function addsMagnified(action: LayoutTreeAction): boolean {
    return !!(action as LayoutTreeInsertNodeAction)?.magnified;
}

// A node that arrives with a size of its own (the AI panel of the Review tab, the onboarding dock, the pipeline tab)
// keeps it: the default size is the mark of a panel that asks for none.
export function hasOwnSize(node: LayoutNode): boolean {
    return node != null && node.size !== DefaultNodeSize;
}

function floorOf(model: LayoutModel): AddedPanelFloor {
    const root = model.treeState?.rootNode;
    const columns = columnsParent(root);
    if (columns == null) {
        return undefined;
    }
    const view360 = model.moltenView360;
    const widthPx =
        view360?.lastEvalWidth > 0
            ? view360.lastEvalWidth
            : (model.displayContainerRef?.current?.getBoundingClientRect?.()?.width ?? 0);
    return {
        parentId: columns.id,
        minsPx: columnMinimumsPx(columns.children.length, currentFirstColumnFloorPx() ?? 0),
        widthPx,
        gapPx: view360?.lastEvalGap ?? 0,
    };
}

// Sets the sizes of the siblings of a node the tree has just taken, before the layout is drawn: no frame shows the new
// panel as a sliver. Returns whether the node's size is settled (and so the size remembered for its kind, #606, does
// not apply), false when it came with a size of its own.
export function rebalanceAddedPanel(model: LayoutModel, node: LayoutNode): boolean {
    const root = model.treeState?.rootNode;
    if (root == null || node == null || hasOwnSize(node)) {
        return false;
    }
    const ops = addedPanelOps(root, node.id, floorOf(model));
    if (ops.length) {
        resizeNode(model.treeState, {
            type: LayoutTreeActionType.ResizeNode,
            resizeOperations: ops,
        } as LayoutTreeResizeNodeAction);
    }
    return true;
}
