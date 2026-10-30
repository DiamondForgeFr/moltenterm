// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// ⌘S hides or shows the workspace sidebar (FR-SHELL-079). An editor that saves on the same key keeps it.

import { getFocusedBlockId, globalStore, WOS } from "@/app/store/global";
import { isMacOS } from "@/util/platformutil";
import { fireAndForget } from "@/util/util";
import { findShortcut } from "../shortcuts/registry";
import { sidebarKeyYields } from "./sidebar-model";
import { SidebarModel } from "./sidebar-store";
import { switchToNumber } from "./sidebar-switch";

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

// ⌥1…⌥9 jump to a workspace (FR-SHELL-082), by the digit's key code so a layout that types other characters with
// Option (or needs Shift for digits) jumps as well. Off macOS, Alt+1…9 already goes to a tab: the Workspace menu's
// Ctrl+Alt+1…9 jump there.
export function workspaceNumberBindings(mac: boolean): string[] {
    if (!mac) {
        return [];
    }
    const rtn: string[] = [];
    for (let n = 1; n <= 9; n++) {
        rtn.push(`Alt:c{Digit${n}}`);
    }
    return rtn;
}

// The keys that jump to the nth workspace, as the menu and the sidebar hints show them (#1345).
export function workspaceJumpKeys(n: number, mac: boolean): string {
    return mac ? `Alt:${n}` : `Ctrl:Alt:${n}`;
}

export function registerSidebarKeys(keyMap: Map<string, (e: WaveKeyboardEvent) => boolean>) {
    const shortcut = findShortcut(ToggleSidebarShortcutId);
    if (shortcut != null) {
        keyMap.set(shortcut.keys, () => toggleSidebarFromKey());
    }
    workspaceNumberBindings(isMacOS()).forEach((keys, i) => {
        keyMap.set(keys, () => {
            fireAndForget(() => switchToNumber(i + 1));
            return true;
        });
    });
}
