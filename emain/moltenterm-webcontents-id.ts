// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// #928: `webContents.fromId` throws on anything but an integer (a webRequest from a destroyed tab view,
// a service worker or main's `net` has no webContentsId), and a throw in a main-process callback quits the app.

import { webContents, type WebContents } from "electron";

export function liveWebContentsFromId(id: unknown): WebContents {
    if (typeof id !== "number" || !Number.isSafeInteger(id)) {
        return null;
    }
    try {
        const wc = webContents.fromId(id);
        return wc == null || wc.isDestroyed() ? null : wc;
    } catch {
        return null;
    }
}
