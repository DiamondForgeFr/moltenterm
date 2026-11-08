// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's back and forward keys (#1744, FR-SHELL-139): the window's key model asks the browser panel that holds the
// focus before it switches views (keymodel.ts), and binds Alt+← and Alt+→ off macOS.

import { getBlockComponentModel } from "@/app/store/global";
import { focusedBlockId } from "@/util/focusutil";
import { isMacOS } from "@/util/platformutil";
import { BrowserKeyTarget, pageHistoryKey, registerHistoryKeys } from "./browser-keys";

function focus() {
    return {
        focusedBlockId,
        modelOf: (blockId: string) => getBlockComponentModel(blockId)?.viewModel as unknown as BrowserKeyTarget,
    };
}

// ⌘[ and ⌘] on macOS; off macOS they are Alt+[ and Alt+], which no browser answers, so the views keep them.
export function windowHistoryKey(direction: 1 | -1): boolean {
    if (!isMacOS()) {
        return false;
    }
    return pageHistoryKey(direction, focus());
}

export function registerBrowserHistoryKeys(keyMap: Map<string, (e: WaveKeyboardEvent) => boolean>): void {
    registerHistoryKeys(keyMap, isMacOS(), (direction) => pageHistoryKey(direction, focus()));
}
