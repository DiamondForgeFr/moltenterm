// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where the keyboard focus is when a window key is pressed (#1759), read from the window; the rule is window-keys.ts's.

import { globalStore, WOS } from "@/app/store/global";
import { currentKeyOriginBlockId, SidebarSelector } from "../newpanel/new-panel-focus";
import { focusInTerminal, KeyFocusFacts } from "./window-keys";

function currentKeyFocusFacts(): KeyFocusFacts {
    const active = typeof document === "undefined" ? null : document.activeElement;
    return {
        originBlockId: currentKeyOriginBlockId(),
        inSidebar: active?.closest?.(SidebarSelector) != null,
        domBlockId: active?.closest?.("[data-blockid]")?.getAttribute("data-blockid"),
    };
}

function viewOfBlock(blockId: string): string {
    const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
    return (block?.meta?.view as string) ?? null;
}

export function keyboardFocusInTerminal(): boolean {
    return focusInTerminal(currentKeyFocusFacts(), viewOfBlock);
}
