// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The app menu's Settings… (⌘,, FR-SHELL-096) opens Preferences as the palette's Settings does, so both follow the
// same rule for where Preferences open.

import { getApi } from "@/app/store/global";
import { fireAndForget } from "@/util/util";
import { runPaletteEntry } from "../palette/palette-actions";

// MoltenTerm's own preload function (emain/preload.ts), typed here so custom.d.ts stays Wave's.
type MoltentermSettingsMenuApi = {
    onMoltentermOpenSettings?: (callback: () => void) => void;
};

let listening = false;

export function openSettingsFromMenu(): Promise<void> {
    return runPaletteEntry({ kind: "settings" }, { placement: "new", blockId: null });
}

export function listenSettingsMenu(): void {
    if (listening) {
        return;
    }
    listening = true;
    (getApi() as unknown as MoltentermSettingsMenuApi)?.onMoltentermOpenSettings?.(() =>
        fireAndForget(openSettingsFromMenu)
    );
}
