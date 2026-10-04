// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import * as electron from "electron";

// The renderer opens Getting started (frontend/moltenterm-onboarding/onboarding-host.ts) when it receives this.
export const MoltentermGettingStartedChannel = "moltenterm-getting-started";
export const MoltentermGettingStartedMenuId = "molten-getting-started";

// The app menu's way back to the first run (FR-ONB-001). targetOf finds the active tab of the window the menu was
// used from; the item has an id so tests can click it through Menu.getApplicationMenu().getMenuItemById().
export function makeMoltentermGettingStartedMenuItem(
    targetOf: (window: electron.BaseWindow) => electron.WebContents
): electron.MenuItemConstructorOptions {
    return {
        id: MoltentermGettingStartedMenuId,
        label: "Getting Started",
        click: (_, window) => {
            targetOf(window)?.send(MoltentermGettingStartedChannel);
        },
    };
}
