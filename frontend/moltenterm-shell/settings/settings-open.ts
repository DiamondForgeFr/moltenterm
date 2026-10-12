// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Opens the settings screen on one of its sections, for the places that point to settings instead of repeating them
// (the first run's agent step links to Agents, where #322 keeps the agent integration).

import { createBlock } from "@/app/store/global";
import { SettingsSectionId, SettingsSections } from "./settings-catalog";

// Block meta of a settings pane: the section it opens on; once open, the screen keeps the section the user picks.
export const SettingsSectionMetaKey = "molten:settings:section";

export function readSettingsSection(value: unknown): SettingsSectionId {
    return SettingsSections.find((s) => s.id === value)?.id ?? null;
}

export function openSettingsSection(section: SettingsSectionId): Promise<string> {
    return createBlock({ meta: { view: "waveconfig", [SettingsSectionMetaKey]: section } as MetaType }, false, true);
}
