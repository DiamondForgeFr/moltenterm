// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import * as electron from "electron";
import {
    MoltentermChoosePathChannel,
    MoltentermChoosePathOpts,
    MoltentermImageExtensions,
} from "../frontend/util/moltenterm-dialogs";

// Answers the chosen path, or null when the user cancels. The dialog is attached to the asking window, so it stays
// in front of it.
export function initMoltentermDialogs() {
    electron.ipcMain.handle(MoltentermChoosePathChannel, async (event, opts: MoltentermChoosePathOpts) => {
        const win = electron.BrowserWindow.fromWebContents(event.sender);
        const image = opts?.kind === "image";
        const options: electron.OpenDialogOptions = {
            title: opts?.title,
            defaultPath: opts?.defaultPath || undefined,
            properties: image ? ["openFile"] : ["openDirectory", "createDirectory"],
            filters: image ? [{ name: "Images", extensions: MoltentermImageExtensions }] : undefined,
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
