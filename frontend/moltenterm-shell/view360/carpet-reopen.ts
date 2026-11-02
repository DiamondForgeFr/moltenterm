// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A panel reopened on the 360 carpet (Cmd+Shift+T, FR-SHELL-126-AC4) comes back at its place among the columns
// (view360-model.ts rewriteAction); this brings it into view and gives it the focus, which wavesrv's split does not.

import type { LayoutModel } from "@/layout/lib/layoutModel";

export type ReopenedPanelStep = "pending" | "shown" | "ignored";

// One attempt: "pending" while the layout has not laid the panel yet (try again), "shown" once it is in view with the
// focus, "ignored" outside 360 view, where the panel keeps the place and the focus the layout gives it.
export function showReopenedPanel(layoutModel: LayoutModel, blockId: string): ReopenedPanelStep {
    const view360 = layoutModel?.moltenView360;
    if (view360?.layout == null || !blockId) {
        return "ignored";
    }
    const node = layoutModel.getNodeByBlockId?.(blockId);
    if (node == null) {
        return "pending";
    }
    view360.revealBlock(blockId);
    layoutModel.focusNode(node.id);
    return "shown";
}
