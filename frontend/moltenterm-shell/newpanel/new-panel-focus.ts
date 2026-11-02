// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where the focus is when ⌘T is pressed (FR-SHELL-086, #1742), read from the window: the panel a page's key came from,
// the panel holding the keyboard focus, or the layout's focused panel; the sidebar holding the focus is no panel.

import { getFocusedBlockId, globalStore, WOS } from "@/app/store/global";
import { focusedPanelBlockId } from "./new-panel-model";

export const SidebarSelector = '[data-testid="workspace-sidebar"]';

let keyOriginBlockId: string = null;

// A key a page held back is sent to the window with the page's panel: ⌘T pressed in the page counts as pressed in
// that panel, even when the layout believes another one focused. Synchronous: the key's handlers run inside fn.
export function runWithKeyOrigin<T>(blockId: string, fn: () => T): T {
    const previous = keyOriginBlockId;
    keyOriginBlockId = blockId ?? null;
    try {
        return fn();
    } finally {
        keyOriginBlockId = previous;
    }
}

// The panel a new panel goes beside when the pointer is over none: the page's panel for a key sent back from a page,
// else the layout's focused panel (the sidebar holding the focus does not change where the panel goes).
export function placementFallbackBlockId(): string {
    return keyOriginBlockId || getFocusedBlockId();
}

// The panel a key counts as pressed in while its handlers run (#1759): the page's panel for a key sent back from a page.
export function currentKeyOriginBlockId(): string {
    return keyOriginBlockId;
}

export function currentFocusedBlockId(): string {
    const active = typeof document === "undefined" ? null : document.activeElement;
    return focusedPanelBlockId({
        originBlockId: keyOriginBlockId,
        inSidebar: active?.closest?.(SidebarSelector) != null,
        domBlockId: active?.closest?.("[data-blockid]")?.getAttribute("data-blockid"),
        layoutBlockId: getFocusedBlockId(),
    });
}

export function currentFocusedView(): string {
    const blockId = currentFocusedBlockId();
    if (!blockId) {
        return null;
    }
    const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
    return (block?.meta?.view as string) ?? null;
}
