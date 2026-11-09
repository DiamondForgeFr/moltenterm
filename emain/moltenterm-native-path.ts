// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import * as electron from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { fireAndForget } from "../frontend/util/util";
import { callWithOriginalXdgCurrentDesktopAsync, getElectronAppResourcesPath, unamePlatform } from "./emain-platform";
import { handleAppIpc, onAppIpc } from "./moltenterm-privileged-ipc";

// The notices the build generates (scripts/moltenterm-notices.mjs) and electron-builder ships under Resources/licenses
// (#2126). In a development run the resources folder is dist/, where the generator writes them.
export const ThirdPartyNoticesChannel = "moltenterm-open-third-party-notices";
const ThirdPartyNoticesFile = "THIRD-PARTY-NOTICES.txt";

export function thirdPartyNoticesPath(resourcesPath: string): string {
    return path.join(resourcesPath, "licenses", ThirdPartyNoticesFile);
}

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
    // The renderer names nothing to open: main resolves the one file this channel is for, so it opens no other path.
    handleAppIpc(ThirdPartyNoticesChannel, () => openThirdPartyNotices(getElectronAppResourcesPath()));
}

// Whether the notices file was handed to the system's viewer; false when this build does not hold it.
export async function openThirdPartyNotices(resourcesPath: string): Promise<boolean> {
    const filePath = thirdPartyNoticesPath(resourcesPath);
    if (!fs.existsSync(filePath)) return false;
    let excuse = "";
    await callWithOriginalXdgCurrentDesktopAsync(async () => {
        excuse = await electron.shell.openPath(filePath);
    });
    if (excuse) console.error(`Failed to open ${filePath} in native application: ${excuse}`);
    return !excuse;
}
