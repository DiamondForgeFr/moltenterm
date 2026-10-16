// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import * as electron from "electron";
import { mt } from "./moltenterm-i18n";

// The renderer opens the workspace edit sheet (frontend/moltenterm-shell/workspace-edit.ts) when it receives this.
export const MoltentermEditWorkspaceChannel = "moltenterm-edit-workspace";
export const MoltentermEditWorkspaceMenuId = "molten-edit-workspace";

type EditTargetView = { waveReadyPromise?: Promise<void>; webContents?: electron.WebContents };

// A workspace the user just created (the rail's "+", Workspace › Create Workspace) opens its edit sheet, focused on
// the name, so it is named where it was asked for (#743). The message names the workspace: only the tab view that shows
// it opens the sheet (frontend/moltenterm-shell/workspace-edit.ts), even when it is still taking it over.
export async function askEditNewWorkspace(view: EditTargetView, workspaceId: string): Promise<void> {
    if (view == null || !workspaceId) {
        return;
    }
    await view.waveReadyPromise;
    const target = view.webContents;
    if (target == null || target.isDestroyed()) {
        return;
    }
    target.send(MoltentermEditWorkspaceChannel, workspaceId);
}

// Workspace › Edit Workspace… (FR-SHELL-030): the sheet of the workspace the window shows. targetOf finds the active
// tab of the window the menu was used from; that tab's renderer knows its workspace, so the message carries none. The
// item has an id so tests can click it through Menu.getApplicationMenu().getMenuItemById().
export function makeMoltentermEditWorkspaceMenuItem(
    targetOf: (window: electron.BaseWindow) => electron.WebContents
): electron.MenuItemConstructorOptions {
    return {
        id: MoltentermEditWorkspaceMenuId,
        label: mt("appMenu.editWorkspace"),
        click: (_, window) => {
            const target = targetOf(window);
            if (target == null || target.isDestroyed()) {
                return;
            }
            target.send(MoltentermEditWorkspaceChannel);
        },
    };
}
