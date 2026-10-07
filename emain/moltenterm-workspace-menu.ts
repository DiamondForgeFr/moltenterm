// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import * as electron from "electron";

// The renderer opens the workspace edit sheet (frontend/moltenterm-shell/workspace-edit.ts) when it receives this.
export const MoltentermEditWorkspaceChannel = "moltenterm-edit-workspace";
export const MoltentermEditWorkspaceMenuId = "molten-edit-workspace";

// Workspace › Edit Workspace… (FR-SHELL-030): the sheet of the workspace the window shows. targetOf finds the active
// tab of the window the menu was used from; that tab's renderer knows its workspace, so the message carries none. The
// item has an id so tests can click it through Menu.getApplicationMenu().getMenuItemById().
export function makeMoltentermEditWorkspaceMenuItem(
    targetOf: (window: electron.BaseWindow) => electron.WebContents
): electron.MenuItemConstructorOptions {
    return {
        id: MoltentermEditWorkspaceMenuId,
        label: "Edit Workspace…",
        click: (_, window) => {
            const target = targetOf(window);
            if (target == null || target.isDestroyed()) {
                return;
            }
            target.send(MoltentermEditWorkspaceChannel);
        },
    };
}
