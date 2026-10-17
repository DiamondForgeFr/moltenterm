// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Equalize panels (#825) from the keyboard and the command panel: once, on the tab on screen.

import { getLayoutModelForStaticTab } from "@/layout/lib/layoutModelHooks";
import { findShortcut } from "../shortcuts/registry";
import type { EqualizeModel } from "./equalize-model";

export const EqualizeShortcutId = "equalize-panels";

export function currentEqualize(): EqualizeModel {
    return getLayoutModelForStaticTab()?.moltenEqualize ?? null;
}

export function equalizeCurrentTab(): boolean {
    const model = currentEqualize();
    if (model == null) {
        return false;
    }
    model.equalize();
    return true;
}

export function registerEqualizeKeys(keyMap: Map<string, (e: WaveKeyboardEvent) => boolean>) {
    const shortcut = findShortcut(EqualizeShortcutId);
    if (shortcut == null) {
        return;
    }
    keyMap.set(shortcut.keys, () => equalizeCurrentTab());
}
