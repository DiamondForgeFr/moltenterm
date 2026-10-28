// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Cmd+/ toggles the shortcut overlay (FR-SHELL-090), whose "All shortcuts" opens the shortcuts sheet (FR-SHELL-042-AC8,
// DS-SHELL-067). It is a global key, so it also works over a web page (Wave hands every global key to the webviews).

import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { modalIsOpen } from "../modal-open";
import { getOverlayController, installShortcutOverlay } from "./overlay-controller";
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
    // Under another modal it opens nothing (#746).
    if (modalIsOpen()) {
        return true;
    }
    modalsModel.pushModal(ShortcutsSheetModalName);
    return true;
}

// Cmd+/ shows the shortcut overlay (FR-SHELL-090, #1242); with the sheet open it closes the sheet. Under another
// modal it opens nothing.
export function toggleShortcutOverlay(): boolean {
    if (modalsModel.isModalOpen(ShortcutsSheetModalName)) {
        closeShortcutsSheet();
        return true;
    }
    if (modalIsOpen()) {
        return true;
    }
    getOverlayController().toggle();
    return true;
}

export function registerShortcutsKeys(keyMap: Map<string, (e: WaveKeyboardEvent) => boolean>) {
    keyMap.set(ShortcutsSheetKey, () => toggleShortcutOverlay());
    keyMap.set(ShortcutsSheetAltKey, () => toggleShortcutOverlay());
    installShortcutOverlay();
}
