// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A password field takes the focus on a page served over plain http (#1980, FR-BRW-023). The web page preload, in its own
// isolated world, tells the window holding the webview: a message with no data, over the webview element's own channel,
// never a method the page can call or a value it can read. The window checks the address of the page it shows before
// it warns, so the page cannot make the warning appear on a page that is not plain http. The focus of a field the page
// shows or adds later counts the same as the user's click: both are where a password would be typed.

import { ipcRenderer } from "electron";
import { InsecurePasswordChannel, warnsAboutPassword } from "../frontend/moltenterm-shell/browser/connection-security";

export function installInsecurePasswordGuest(): void {
    document.addEventListener(
        "focusin",
        (event) => {
            if (!event.isTrusted) {
                return;
            }
            const target = event.composedPath()[0];
            if (!(target instanceof HTMLInputElement) || target.type !== "password") {
                return;
            }
            if (warnsAboutPassword(location.href)) {
                ipcRenderer.sendToHost(InsecurePasswordChannel);
            }
        },
        true
    );
}
