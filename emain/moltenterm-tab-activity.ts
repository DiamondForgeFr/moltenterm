// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The main process's side of the tab activity model (FR-PERF-009, DS-PERF-008): every tab view of a window learns
// whether the window is focused, minimised or shown, when it starts and at each change. Which view is on screen the
// renderer reads from the workspace itself (frontend/moltenterm-shell/tab-activity.ts), so this file needs no hook in
// the window's tab switching. A document inside a WebContentsView keeps visibilityState "visible" while the window is
// unfocused, and while the view only sits off-screen (#68), so the renderer cannot tell these apart on its own.

import { ipcMain } from "electron";
import { globalEvents } from "./emain-events";
import { getAllWaveWindows, getWaveWindowByWebContentsId, WaveBrowserWindow } from "./emain-window";

export const WindowActivityChannel = "moltenterm-window-activity";
export const WindowActivityGetChannel = "moltenterm-window-activity-get";

// must match WindowActivity in frontend/moltenterm-shell/tab-activity-model.ts
export type WindowActivity = { focused: boolean; minimized: boolean; shown: boolean };

const WindowEvents = ["focus", "blur", "minimize", "restore", "show", "hide"] as const;

type WindowLike = {
    isDestroyed(): boolean;
    isFocused(): boolean;
    isMinimized(): boolean;
    isVisible(): boolean;
};

export function windowActivityOf(win: WindowLike): WindowActivity {
    if (win == null || win.isDestroyed()) {
        return null;
    }
    return { focused: win.isFocused(), minimized: win.isMinimized(), shown: win.isVisible() };
}

const watchedWindows = new WeakSet<WaveBrowserWindow>();

function sendWindowActivity(win: WaveBrowserWindow) {
    const activity = windowActivityOf(win);
    if (activity == null) {
        return;
    }
    for (const tabView of win.allLoadedTabViews.values()) {
        if (tabView.isDestroyed || tabView.webContents == null || tabView.webContents.isDestroyed()) {
            continue;
        }
        tabView.webContents.send(WindowActivityChannel, activity);
    }
}

function watchWindow(win: WaveBrowserWindow) {
    if (watchedWindows.has(win) || win.isDestroyed()) {
        return;
    }
    watchedWindows.add(win);
    for (const name of WindowEvents) {
        win.on(name as any, () => sendWindowActivity(win));
    }
}

export function initMoltentermTabActivity() {
    ipcMain.on(WindowActivityGetChannel, (event) => {
        event.returnValue = windowActivityOf(getWaveWindowByWebContentsId(event.sender.id));
    });
    // Emitted for each new window (and on focus, blur and close): the only place a window shows up outside
    // emain-window.ts.
    globalEvents.on("windows-updated", () => {
        for (const win of getAllWaveWindows()) {
            watchWindow(win);
        }
    });
}
