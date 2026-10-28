// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Spaces frame (DS-SHELL-127, #1216): with the workspace sidebar hidden no top bar holds the window buttons, so
// they show only while the pointer is at the window's top-left corner (or the sidebar peeks). Only macOS draws them
// inside the window; elsewhere the window keeps its own controls and this does nothing. The page only sends while it
// is the tab shown (workspace-sidebar.tsx), so a cached tab never speaks for the window.

import { getWaveWindowByWebContentsId } from "./emain-window";
import { onAppIpc } from "./moltenterm-privileged-ipc";

type ButtonsWindow = {
    isDestroyed(): boolean;
    setWindowButtonVisibility?(visible: boolean): void;
};

export function applyWindowButtons(win: ButtonsWindow, visible: unknown, platform: string): boolean {
    if (platform !== "darwin" || win == null || win.isDestroyed()) {
        return false;
    }
    win.setWindowButtonVisibility?.(visible === true);
    return true;
}

let initialized = false;

export function initMoltentermWindowButtons() {
    if (initialized) return;
    initialized = true;
    onAppIpc("moltenterm-window-buttons", (event, visible: unknown) => {
        applyWindowButtons(getWaveWindowByWebContentsId(event.sender.id), visible, process.platform);
    });
}
