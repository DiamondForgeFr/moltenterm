// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { app, webContents } from "electron";
import { onAppIpc } from "./moltenterm-privileged-ipc";
import type { AccessibilitySnapshot } from "../frontend/moltenterm-shell/terminal-accessibility/screen-reader";
import { getWaveTabViewByWebContentsId } from "./emain-tabview";

let initialized = false;

export function initMoltentermAccessibility() {
    if (initialized) return;
    initialized = true;
    let snapshot: AccessibilitySnapshot = { available: false, enabled: false, revision: 0 };
    if (process.platform === "darwin" || process.platform === "win32") {
        try {
            snapshot = { available: true, enabled: app.isAccessibilitySupportEnabled(), revision: 0 };
        } catch {
            // Unsupported detection must not prevent explicit terminal accessibility.
        }
    }
    onAppIpc("moltenterm:get-accessibility-support", (event) => {
        const sender = event.sender;
        const tab = !sender.isDestroyed() && getWaveTabViewByWebContentsId(sender.id);
        event.returnValue =
            tab && event.senderFrame === sender.mainFrame
                ? snapshot
                : { available: false, enabled: false, revision: 0 };
    });
    app.on("accessibility-support-changed", (_event, enabled) => {
        snapshot = { available: true, enabled, revision: snapshot.revision + 1 };
        for (const contents of webContents.getAllWebContents()) {
            if (!contents.isDestroyed() && getWaveTabViewByWebContentsId(contents.id)) {
                contents.send("moltenterm:accessibility-support-changed", snapshot);
            }
        }
    });
}
