// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import * as electron from "electron";
import { fireAndForget } from "../frontend/util/util";
import { callWithOriginalXdgCurrentDesktopAsync, unamePlatform } from "./emain-platform";
import { onAppIpc } from "./moltenterm-privileged-ipc";

export function expandNativeHome(value: unknown, home: string, platform: string): string {
    if (typeof value !== "string" || value === "") return null;
    if (value === "~") return home;
    if (value.startsWith("~/") || (platform === "win32" && value.startsWith("~\\"))) {
        return home.replace(/[\\/]$/, "") + value.slice(1);
    }
    return value;
}

export function initNativePathIpc() {
    onAppIpc("open-native-path", (_event, value: unknown) => {
        const filePath = expandNativeHome(value, electron.app.getPath("home"), unamePlatform);
        if (filePath == null) return;
        fireAndForget(() =>
            callWithOriginalXdgCurrentDesktopAsync(() =>
                electron.shell.openPath(filePath).then((excuse) => {
                    if (excuse) console.error(`Failed to open ${filePath} in native application: ${excuse}`);
                })
            )
        );
    });
    onAppIpc("reveal-native-path", (_event, value: unknown) => {
        const filePath = expandNativeHome(value, electron.app.getPath("home"), unamePlatform);
        if (filePath != null) electron.shell.showItemInFolder(filePath);
    });
}
