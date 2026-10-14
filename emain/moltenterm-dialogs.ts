// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import * as electron from "electron";
import {
    MoltentermChoosePathChannel,
    MoltentermChoosePathOpts,
    MoltentermImageExtensions,
    MoltentermWorkspaceIconExtensions,
} from "../frontend/util/moltenterm-dialogs";
import { mt } from "./moltenterm-i18n";

// Answers the chosen path, or null when the user cancels. The dialog is attached to the asking window, so it stays
// in front of it.
export function initMoltentermDialogs() {
    electron.ipcMain.handle(MoltentermChoosePathChannel, async (event, opts: MoltentermChoosePathOpts) => {
        const win = electron.BrowserWindow.fromWebContents(event.sender);
        const workspaceIcon = opts?.kind === "workspaceicon";
        const image = opts?.kind === "image" || workspaceIcon;
        const extensions = workspaceIcon ? MoltentermWorkspaceIconExtensions : MoltentermImageExtensions;
        const options: electron.OpenDialogOptions = {
            title: opts?.title,
            defaultPath: opts?.defaultPath || undefined,
            // The system's own label follows the bundle's localizations, not the interface language (FR-I18N-001).
            buttonLabel: mt("dialog.chooseFolder"),
            properties: image ? ["openFile"] : ["openDirectory", "createDirectory"],
            filters: image ? [{ name: mt("dialog.images"), extensions }] : undefined,
        };
        const result =
            win == null
                ? await electron.dialog.showOpenDialog(options)
                : await electron.dialog.showOpenDialog(win, options);
        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }
        return result.filePaths[0];
    });
}
