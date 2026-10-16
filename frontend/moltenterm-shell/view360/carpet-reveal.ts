// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Keyboard overlays and modes drawn on a panel (the split placement, find, the connection switcher) first bring that
// panel into view on the 360 carpet (#747), so a keyboard user never lands in a mode they cannot see.

import { globalStore } from "@/app/store/jotaiStore";
import { getLayoutModelForStaticTab } from "@/layout/lib/layoutModelHooks";

// Whether the tab's layout draws a panel for the block: an overlay on a block without one would be an invisible mode.
export function panelIsLaidOut(blockId: string): boolean {
    if (!blockId) {
        return false;
    }
    const layoutModel = getLayoutModelForStaticTab();
    if (layoutModel?.getNodeByBlockId == null) {
        return true;
    }
    if (layoutModel.getNodeByBlockId(blockId) != null) {
        return true;
    }
    const ephemeral = layoutModel.ephemeralNode == null ? null : globalStore.get(layoutModel.ephemeralNode);
    return ephemeral?.data?.blockId === blockId;
}

export function revealPanelOnCarpet(blockId: string): void {
    if (!blockId) {
        return;
    }
    getLayoutModelForStaticTab()?.moltenView360?.revealBlock(blockId);
}
