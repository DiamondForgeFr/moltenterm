// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Where the keyboard focus is when a window key is pressed (#1759), read from the window; the rule is window-keys.ts's.

import { globalStore, WOS } from "@/app/store/global";
import { currentKeyOriginBlockId, SidebarSelector } from "../newpanel/new-panel-focus";
import { EditorSelector, focusInTerminalOrEditor, KeyFocusFacts } from "./window-keys";

function currentKeyFocusFacts(): KeyFocusFacts {
    const active = typeof document === "undefined" ? null : document.activeElement;
    return {
        originBlockId: currentKeyOriginBlockId(),
        inSidebar: active?.closest?.(SidebarSelector) != null,
        inEditor: active?.closest?.(EditorSelector) != null,
        domBlockId: active?.closest?.("[data-blockid]")?.getAttribute("data-blockid"),
    };
}

function viewOfBlock(blockId: string): string {
    const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
    return (block?.meta?.view as string) ?? null;
}

export function keyboardFocusInTerminalOrEditor(): boolean {
    return focusInTerminalOrEditor(currentKeyFocusFacts(), viewOfBlock);
}
