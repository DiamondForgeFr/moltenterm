// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { LayoutNode, LayoutTreeActionType, LayoutTreeSplitHorizontalAction } from "@/layout/lib/types";

// The panel's share of the width when a window docks it: 7 against the tab's 10, as wavesrv's first-run layout.
export const PanelNodeSize = 7;

// Docks a new pane along the whole height of the tab, on its left: splitting the root node wraps it in a new row
// (layoutTree.ts, splitHorizontal), so the panel sits beside everything already open.
export function dockAction(rootNodeId: string, newNode: LayoutNode): LayoutTreeSplitHorizontalAction {
    return {
        type: LayoutTreeActionType.SplitHorizontal,
        targetNodeId: rootNodeId,
        newNode,
        position: "before",
        focused: true,
    };
}
