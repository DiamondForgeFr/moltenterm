// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Cmd+/ toggles the shortcuts sheet (FR-SHELL-042-AC8, DS-SHELL-067). It is a global key, so it also works over a web
// page (Wave hands every global key to the webviews).

import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { ShortcutsSheetAltKey, ShortcutsSheetKey } from "./registry";

export const ShortcutsSheetModalName = "MoltentermShortcutsSheet";

export function closeShortcutsSheet() {
    const modals = globalStore.get(modalsModel.modalsAtom);
    globalStore.set(
        modalsModel.modalsAtom,
        modals.filter((m) => m.displayName !== ShortcutsSheetModalName)
    );
}

export function openShortcutsSheet() {
    if (modalsModel.isModalOpen(ShortcutsSheetModalName)) {
        return;
    }
    modalsModel.pushModal(ShortcutsSheetModalName);
}

export function toggleShortcutsSheet(): boolean {
    if (modalsModel.isModalOpen(ShortcutsSheetModalName)) {
        closeShortcutsSheet();
        return true;
    }
    modalsModel.pushModal(ShortcutsSheetModalName);
    return true;
}

export function registerShortcutsKeys(keyMap: Map<string, (e: WaveKeyboardEvent) => boolean>) {
    keyMap.set(ShortcutsSheetKey, () => toggleShortcutsSheet());
    keyMap.set(ShortcutsSheetAltKey, () => toggleShortcutsSheet());
}
