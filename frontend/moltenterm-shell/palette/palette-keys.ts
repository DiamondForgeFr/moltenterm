// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The global shortcut of the command palette (FR-SHELL-013). Cmd+K is taken: in a terminal it clears the scrollback
// (Wave's term-model.ts, the macOS terminal convention), so the palette takes the closest free binding, Cmd+Shift+K.
// Wave's "Cmd" is the Meta key on macOS and Alt elsewhere.

import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { registerCommandPanelKeys } from "../command-panel/command-panel-keys";
import { registerCompanionKeys } from "../companion/companion-open";
import { registerShortcutsKeys } from "../shortcuts/shortcuts-keys";

export const CommandPaletteKey = "Cmd:Shift:k";
export const CommandPaletteModalName = "MoltentermCommandPaletteModal";

export function closeCommandPalette() {
    const modals = globalStore.get(modalsModel.modalsAtom);
    globalStore.set(
        modalsModel.modalsAtom,
        modals.filter((m) => m.displayName !== CommandPaletteModalName)
    );
}

// The shortcut toggles: pressed again, it closes the palette.
export function toggleCommandPalette(): boolean {
    if (modalsModel.isModalOpen(CommandPaletteModalName)) {
        closeCommandPalette();
        return true;
    }
    modalsModel.pushModal(CommandPaletteModalName);
    return true;
}

// Wave's key model calls this once for the shell's global keys: the palette's, the agent companion's (Cmd+Shift+J,
// FR-SHELL-018), the shortcuts sheet's (Cmd+/, FR-SHELL-042) and the command panel's (Cmd+., FR-SHELL-047), so a new
// key costs no Wave edit.
export function registerCommandPaletteKeys(keyMap: Map<string, (e: WaveKeyboardEvent) => boolean>) {
    keyMap.set(CommandPaletteKey, () => toggleCommandPalette());
    registerCompanionKeys(keyMap);
    registerShortcutsKeys(keyMap);
    registerCommandPanelKeys(keyMap);
}
