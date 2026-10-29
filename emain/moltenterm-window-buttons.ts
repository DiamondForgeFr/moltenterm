// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Spaces frame (DS-SHELL-127, #1216, #1279): the window buttons come and go with the workspace sidebar, and sit on
// the window row's centre line, or inside the floating panel while the sidebar is hidden (#1293). macOS draws them at the top left: they are placed and shown or hidden. Elsewhere the
// window controls are drawn over the page at the top right: they take the row's height so they share its centre line.
// The page only sends while it is the tab shown (workspace-sidebar.tsx), so a cached tab never speaks for the window.

import {
    controlsOverlayHeight,
    DefaultControlsOverlayPx,
    macButtonsPosition,
    readWindowButtonsMessage,
} from "../frontend/moltenterm-shell/sidebar/window-corner-model";
import { getWaveWindowByWebContentsId } from "./emain-window";
import { onAppIpc } from "./moltenterm-privileged-ipc";

type ButtonsWindow = {
    isDestroyed(): boolean;
    setWindowButtonVisibility?(visible: boolean): void;
    setWindowButtonPosition?(position: { x: number; y: number } | null): void;
    setTitleBarOverlay?(options: { height: number }): void;
};

export function applyWindowButtons(win: ButtonsWindow, value: unknown, platform: string): boolean {
    if (win == null || win.isDestroyed()) {
        return false;
    }
    const msg = readWindowButtonsMessage(value);
    if (platform === "darwin") {
        // Showing hidden buttons puts them back where the system draws them by default (#1301): the floating sidebar's
        // buttons stayed at the window corner. Placed before, so they never show elsewhere, and again after.
        const position = msg == null ? null : macButtonsPosition(msg.zoom, msg.peekGap);
        win.setWindowButtonPosition?.(position);
        win.setWindowButtonVisibility?.(msg == null || msg.visible);
        win.setWindowButtonPosition?.(position);
        return true;
    }
    if (platform !== "win32" && platform !== "linux") {
        return false;
    }
    try {
        win.setTitleBarOverlay?.({ height: msg == null ? DefaultControlsOverlayPx : controlsOverlayHeight(msg.zoom) });
    } catch {
        // A window with the native title bar has no overlay to size.
        return false;
    }
    return true;
}

let initialized = false;

export function initMoltentermWindowButtons() {
    if (initialized) return;
    initialized = true;
    onAppIpc("moltenterm-window-buttons", (event, value: unknown) => {
        applyWindowButtons(getWaveWindowByWebContentsId(event.sender.id), value, process.platform);
    });
}
