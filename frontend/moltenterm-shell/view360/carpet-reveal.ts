// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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

// A panel the agent shows the developer (#1812, #1994) comes into view whatever the layout: a 360 carpet glides to its
// column, and in a grid a magnified panel, which hides every other, gives way. Nothing is moved, resized or closed, and
// the focus stays where it is: the magnification ends without focusing the panel, and the carpet only scrolls. A panel
// of another tab, or one already in view, changes nothing.
export function bringPanelIntoView(blockId: string): void {
    if (!blockId) {
        return;
    }
    const layoutModel = getLayoutModelForStaticTab();
    const node = layoutModel?.getNodeByBlockId?.(blockId);
    if (node == null) {
        return;
    }
    const magnified = layoutModel.magnifiedNodeId;
    if (magnified != null && magnified !== node.id) {
        layoutModel.magnifyNodeToggle(magnified);
    }
    layoutModel.moltenView360?.revealBlock(blockId);
}
