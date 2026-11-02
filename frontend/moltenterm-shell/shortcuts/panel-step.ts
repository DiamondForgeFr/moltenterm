// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Previous and next panel from the keyboard (#1759, FR-SHELL-139 AC9): a panel is a browser tab. In 360 view the key
// steps along the carpet as Ctrl+Tab does (FR-SHELL-126); in any other view it follows the panels' order, wrapping.

import { globalStore } from "@/app/store/jotaiStore";
import { getLayoutModelForStaticTab } from "@/layout/lib/layoutModelHooks";
import { stepCarpet } from "../view360/carpet-keys";
import { stepPanelId } from "./window-keys";

// false when there is nowhere to go, so that the key reaches the program.
export function stepPanel(direction: 1 | -1): boolean {
    const layoutModel = getLayoutModelForStaticTab();
    if (layoutModel == null) {
        return false;
    }
    if (stepCarpet(layoutModel, direction)) {
        return true;
    }
    const nodeIds = (globalStore.get(layoutModel.leafOrder) ?? []).map((leaf) => leaf.nodeid);
    const focused = globalStore.get(layoutModel.focusedNode);
    const target = stepPanelId(nodeIds, focused?.id, direction);
    if (target == null) {
        return false;
    }
    // A magnified panel hides the others: the magnification moves with the focus, or the focus would land out of sight.
    if (layoutModel.magnifiedNodeId != null && layoutModel.magnifiedNodeId !== target) {
        layoutModel.magnifyNodeToggle(target);
        return true;
    }
    layoutModel.focusNode(target);
    return true;
}
