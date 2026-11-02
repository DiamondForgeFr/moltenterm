// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The global shortcut of the command palette (FR-SHELL-013). Cmd+K is taken: in a terminal it clears the scrollback
// (Wave's term-model.ts, the macOS terminal convention), so the palette takes the closest free binding, Cmd+Shift+K.
// Wave's "Cmd" is the Meta key on macOS and Alt elsewhere.

import { getFocusedBlockId, refocusNode } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { registerCommandPanelKeys } from "../command-panel/command-panel-keys";
import { registerCompanionKeys } from "../companion/companion-open";
import { listenAppMenuCommands } from "../menu/app-menu-commands";
import { modalIsOpen } from "../modal-open";
import { registerShortcutsKeys } from "../shortcuts/shortcuts-keys";
import { TopFieldModel } from "../sidebar/top-field-store";
import { registerPinKeys } from "../view360/view360-pin";

export const CommandPaletteKey = "Cmd:Shift:k";
export const CommandPaletteModalName = "MoltentermCommandPaletteModal";

export function closeCommandPalette() {
    const modals = globalStore.get(modalsModel.modalsAtom);
    globalStore.set(
        modalsModel.modalsAtom,
        modals.filter((m) => m.displayName !== CommandPaletteModalName)
    );
}

// One search surface (FR-SHELL-113): the palette lives in the sidebar's top field, which lists its panels, actions and
// panel commands. With the sidebar turned off there is no field, and the shortcut opens the palette dialog as before.
// The shortcut toggles: pressed again, it closes the field or the dialog. Under a modal it opens nothing (#746).
export function toggleCommandPalette(): boolean {
    if (modalsModel.isModalOpen(CommandPaletteModalName)) {
        closeCommandPalette();
        return true;
    }
    if (modalIsOpen()) {
        return true;
    }
    const field = TopFieldModel.getInstance();
    if (field.isOpen()) {
        field.dismiss();
        const blockId = getFocusedBlockId();
        if (blockId) {
            refocusNode(blockId);
        }
        return true;
    }
    if (field.open()) {
        return true;
    }
    modalsModel.pushModal(CommandPaletteModalName);
    return true;
}

// Wave's key model calls this once for the shell's global keys: the palette's, the agent companion's (Cmd+Shift+J,
// FR-SHELL-018), the shortcuts sheet's (Cmd+/, FR-SHELL-042) and the command panel's (Cmd+., FR-SHELL-047), so a new
// key costs no Wave edit. The app's View and Help menus run the same keys (FR-SHELL-113), so they get the map too.
export function registerCommandPaletteKeys(keyMap: Map<string, (e: WaveKeyboardEvent) => boolean>) {
    keyMap.set(CommandPaletteKey, () => toggleCommandPalette());
    registerCompanionKeys(keyMap);
    registerShortcutsKeys(keyMap);
    registerCommandPanelKeys(keyMap);
    registerPinKeys(keyMap);
    listenAppMenuCommands(keyMap);
}
