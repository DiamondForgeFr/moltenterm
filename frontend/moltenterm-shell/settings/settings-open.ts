// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Opens the settings screen on one of its sections, for the places that point to settings instead of repeating them
// (the first run's agent step links to Agents, where #322 keeps the agent integration). Every way into Preferences
// comes here, so none of them adds a panel to a pinned view (FR-SHELL-094).

import { openAppPanel } from "../app-panel";
import { SettingsSectionId, SettingsSections } from "./settings-catalog";

const SettingsView = "waveconfig";

// Block meta of a settings pane: the section it opens on; once open, the screen keeps the section the user picks.
// A screen already open receives it too, shows that section and clears it (settings-screen.tsx).
export const SettingsSectionMetaKey = "molten:settings:section";

export function readSettingsSection(value: unknown): SettingsSectionId {
    return SettingsSections.find((s) => s.id === value)?.id ?? null;
}

// The settings screen, or with a file, that settings file in the JSON editor.
export function openSettings(file?: string): Promise<void> {
    return openAppPanel({ meta: file ? { view: SettingsView, file } : { view: SettingsView } }, { ephemeral: true });
}

export function openSettingsSection(section: SettingsSectionId): Promise<void> {
    return openAppPanel(
        { meta: { view: SettingsView, [SettingsSectionMetaKey]: section } as MetaType },
        { ephemeral: true, patch: { [SettingsSectionMetaKey]: section } }
    );
}
