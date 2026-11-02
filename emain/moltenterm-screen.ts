// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The screen a window is on (FR-SHELL-066, #1083): the 360 view's column threshold is remembered per screen, keyed by
// the display's size and scale factor. Every tab view of a window learns its screen at start and whenever the window
// moves to another display or the display itself changes (resolution, scaling).

import { screen } from "electron";
import { globalEvents } from "./emain-events";
import { getAllWaveWindows, getWaveWindowByWebContentsId, WaveBrowserWindow } from "./emain-window";
import { onAppIpc } from "./moltenterm-privileged-ipc";

export const ScreenChannel = "moltenterm-screen";
export const ScreenGetChannel = "moltenterm-screen-get";

// must match ScreenInfo in frontend/moltenterm-shell/view360/screen-threshold.ts
export type ScreenInfo = { key: string; widthpx: number; heightpx: number; scalefactor: number };

type DisplayLike = { size: { width: number; height: number }; scaleFactor: number };

export function screenInfoOf(display: DisplayLike): ScreenInfo {
    if (display?.size == null) {
        return null;
    }
    const width = Math.round(display.size.width);
    const height = Math.round(display.size.height);
    const scale = Math.round((display.scaleFactor || 1) * 100) / 100;
    return { key: `${width}x${height}@${scale}`, widthpx: width, heightpx: height, scalefactor: scale };
}

function windowScreen(win: WaveBrowserWindow): ScreenInfo {
    if (win == null || win.isDestroyed()) {
        return null;
    }
    try {
        return screenInfoOf(screen.getDisplayMatching(win.getBounds()));
    } catch {
        return null;
    }
}

const watchedWindows = new WeakSet<WaveBrowserWindow>();
const lastKeys = new WeakMap<WaveBrowserWindow, string>();

function sendScreen(win: WaveBrowserWindow, force = false) {
    const info = windowScreen(win);
    if (info == null || (!force && lastKeys.get(win) === info.key)) {
        return;
    }
    lastKeys.set(win, info.key);
    for (const tabView of win.allLoadedTabViews.values()) {
        if (tabView.isDestroyed || tabView.webContents == null || tabView.webContents.isDestroyed()) {
            continue;
        }
        tabView.webContents.send(ScreenChannel, info);
    }
}

function watchWindow(win: WaveBrowserWindow) {
    if (watchedWindows.has(win) || win.isDestroyed()) {
        return;
    }
    watchedWindows.add(win);
    lastKeys.set(win, windowScreen(win)?.key);
    // "moved" fires once a drag ends on some platforms only; "move" covers the others (sendScreen skips unchanged keys).
    for (const name of ["moved", "move", "resize"]) {
        win.on(name as any, () => sendScreen(win));
    }
}

function sendToAllWindows() {
    for (const win of getAllWaveWindows()) {
        sendScreen(win, true);
    }
}

export function initMoltentermScreen() {
    onAppIpc(ScreenGetChannel, (event) => {
        event.returnValue = windowScreen(getWaveWindowByWebContentsId(event.sender.id));
    });
    globalEvents.on("windows-updated", () => {
        for (const win of getAllWaveWindows()) {
            watchWindow(win);
        }
    });
    screen.on("display-metrics-changed", sendToAllWindows);
    screen.on("display-added", sendToAllWindows);
    screen.on("display-removed", sendToAllWindows);
}
