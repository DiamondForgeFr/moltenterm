// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// ⌘S hides or shows the workspace sidebar (FR-SHELL-079). An editor that saves on the same key keeps it.

import { getFocusedBlockId, globalStore, WOS } from "@/app/store/global";
import { findShortcut } from "../shortcuts/registry";
import { sidebarKeyYields } from "./sidebar-model";
import { SidebarModel } from "./sidebar-store";

export const ToggleSidebarShortcutId = "toggle-sidebar";

function focusedView(): string {
    const blockId = getFocusedBlockId();
    if (!blockId) {
        return "";
    }
    return globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)))?.meta?.view ?? "";
}

export function toggleSidebarFromKey(): boolean {
    const model = SidebarModel.getInstance();
    if (!model.isEnabled() || sidebarKeyYields(document.activeElement, focusedView())) {
        return false;
    }
    model.toggleHidden();
    return true;
}

export function registerSidebarKeys(keyMap: Map<string, (e: WaveKeyboardEvent) => boolean>) {
    const shortcut = findShortcut(ToggleSidebarShortcutId);
    if (shortcut == null) {
        return;
    }
    keyMap.set(shortcut.keys, () => toggleSidebarFromKey());
}
