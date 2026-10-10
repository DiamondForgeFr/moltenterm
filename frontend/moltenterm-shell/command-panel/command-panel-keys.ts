// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Cmd+. opens the focused panel's command panel (FR-SHELL-047-AC1); pressed again, it closes it. A global key, so it
// works from a terminal and over a web page too (Wave hands every global key to the webviews).

import { toggleFocusedCommandPanel } from "./command-panel-store";

export const CommandPanelKey = "Cmd:.";

export function registerCommandPanelKeys(keyMap: Map<string, (e: WaveKeyboardEvent) => boolean>) {
    keyMap.set(CommandPanelKey, () => toggleFocusedCommandPanel());
}
