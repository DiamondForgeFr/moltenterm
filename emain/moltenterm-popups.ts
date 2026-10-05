// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Sign-in popups in the in-app engine (FR-BRW-003, DS-BRW-003). Wave denied every window.open of a page and turned it
// into a new tab, so window.open returned null and a sign-in that posts its result to window.opener could never
// finish. A window meant as a popup (size or "popup" feature, or an empty window its opener fills) is now a real
// child window of the MoltenTerm window, with its opener; links and feature-less window.open still become panel tabs
// (#140). A provider refusal seen in a popup closes it and asks the opener's panel tab to show the refusal bar.

import type { BrowserWindow, HandlerDetails, WebContents, WindowOpenHandlerResponse } from "electron";
import {
    centerIn,
    classifyWindowOpen,
    detectSignInRefusal,
    popupBounds,
    popupTitle,
    WindowOpenDeny,
    WindowOpenPopup,
} from "../frontend/moltenterm-shell/browser/browser-popup";
import type { WaveTabView } from "./emain-tabview";
import { getWaveWindowById } from "./emain-window";

// Received by emain/preload.ts, which dispatches it to the panel webview that opened the popup.
export const SignInRefusedChannel = "moltenterm-signin-refused";
const NewWindowChannel = "webview-new-window";

function alive(wc: WebContents): boolean {
    return wc != null && !wc.isDestroyed();
}

// guest is the panel tab's webview; source is the page asking (the guest, or a popup it opened).
function handleWindowOpen(
    tabView: WaveTabView,
    guest: WebContents,
    source: WebContents,
    details: HandlerDetails
): WindowOpenHandlerResponse {
    if (!alive(guest) || !alive(source) || !alive(tabView.webContents)) {
        return { action: "deny" };
    }
    const kind = classifyWindowOpen(details);
    if (kind === WindowOpenDeny) {
        return { action: "deny" };
    }
    if (kind !== WindowOpenPopup) {
        // Wave's behaviour: the panel opens the page as a tab of the webview that asked.
        tabView.webContents.send(NewWindowChannel, guest.id, details);
        return { action: "deny" };
    }
    const parent = parentWindowOf(tabView, source);
    const bounds = popupBounds(details.features);
    const placed =
        bounds.x != null ? { x: bounds.x, y: bounds.y } : parent != null ? centerIn(bounds, parent.getBounds()) : {};
    return {
        action: "allow",
        outlivesOpener: false,
        overrideBrowserWindowOptions: {
            ...placed,
            width: bounds.width,
            height: bounds.height,
            parent: parent ?? undefined,
            show: true,
            autoHideMenuBar: true,
            fullscreenable: false,
            webPreferences: {
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
                webviewTag: false,
            },
        },
    };
}

// A popup opened from a popup stacks on it; the first one on the MoltenTerm window.
function parentWindowOf(tabView: WaveTabView, source: WebContents): Electron.BaseWindow {
    const popup = popupWindows.get(source.id);
    if (popup != null && !popup.isDestroyed()) {
        return popup;
    }
    return getWaveWindowById(tabView.waveWindowId) ?? null;
}

const popupWindows = new Map<number, BrowserWindow>();

function configurePopup(tabView: WaveTabView, guest: WebContents, win: BrowserWindow): void {
    const wc = win.webContents;
    const wcId = wc.id;
    popupWindows.set(wcId, win);
    wc.setWindowOpenHandler((details) => handleWindowOpen(tabView, guest, wc, details));
    wc.on("did-create-window", (child) => configurePopup(tabView, guest, child));
    const updateTitle = () => {
        if (!win.isDestroyed()) {
            win.setTitle(popupTitle(wc.getURL(), wc.getTitle()));
        }
    };
    wc.on("page-title-updated", (e) => {
        e.preventDefault();
        updateTitle();
    });
    const checkRefusal = (url: string) => {
        updateTitle();
        const refusal = detectSignInRefusal(url);
        if (refusal == null) {
            return;
        }
        console.log("molten popup: sign-in refused by", refusal.provider);
        if (alive(tabView.webContents) && alive(guest)) {
            tabView.webContents.send(SignInRefusedChannel, guest.id, refusal);
        }
        if (!win.isDestroyed()) {
            win.close();
        }
    };
    wc.on("did-navigate", (_e, url) => checkRefusal(url));
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => {
        if (isMainFrame) {
            checkRefusal(url);
        }
    });
    // The app menu has no Cmd+W accelerator (the tab view handles it), so the popup closes itself.
    wc.on("before-input-event", (e, input) => {
        if (input.type !== "keyDown" || input.key.toLowerCase() !== "w") {
            return;
        }
        const mod = process.platform === "darwin" ? input.meta : input.control;
        if (!mod || input.shift || input.alt) {
            return;
        }
        e.preventDefault();
        win.close();
    });
    win.on("closed", () => {
        popupWindows.delete(wcId);
        const parent = win.getParentWindow?.() ?? getWaveWindowById(tabView.waveWindowId);
        if (parent != null && !parent.isDestroyed()) {
            parent.focus();
        }
        // Back to the page that opened the popup, unless that was another popup still open.
        if (alive(guest) && parent === getWaveWindowById(tabView.waveWindowId)) {
            guest.focus();
        }
    });
}

// Called for each webview a tab view attaches (the browser panel's tabs).
export function attachWebviewWindowOpen(tabView: WaveTabView, guest: WebContents): void {
    guest.setWindowOpenHandler((details) => handleWindowOpen(tabView, guest, guest, details));
    guest.on("did-create-window", (win) => configurePopup(tabView, guest, win));
}
