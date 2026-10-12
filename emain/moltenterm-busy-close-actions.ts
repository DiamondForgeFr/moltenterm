// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The four closes Electron main decides, asked like FR-SHELL-061 (FR-SHELL-062, DS-SHELL-109): which renderer asks,
// what the action stops, and bringing a minimised or hidden window forward when its renderer has to ask. Called from
// the window's close handler, switchWorkspace and delete-workspace (emain/emain-window.ts) and before-quit
// (emain/emain.ts).

import { WorkspaceService } from "@/app/store/services";
import { app } from "electron";
import { getAllBuilderWindows } from "./emain-builder";
import { unamePlatform } from "./emain-platform";
import type { WaveBrowserWindow } from "./emain-window";
import { askBusyStop, askOncePerAction, BusyAskTarget } from "./moltenterm-busy-close";
import {
    BusyAskKindDelete,
    BusyAskKindQuit,
    BusyAskKindSwitch,
    BusyAskKindWindow,
    BusyOutcomeCancel,
    BusyOutcomeNone,
    switchStops,
    windowCloseStops,
} from "./moltenterm-busy-close-policy";

function windowTarget(win: WaveBrowserWindow): BusyAskTarget {
    if (win == null || win.isDestroyed()) {
        return null;
    }
    const wc = win.activeTabView?.webContents;
    return wc != null && !wc.isDestroyed() ? wc : null;
}

// The dialog is drawn by the window's view: a minimised or hidden window would ask where nobody sees it.
function bringForward(win: WaveBrowserWindow) {
    if (win == null || win.isDestroyed()) {
        return;
    }
    if (win.isMinimized()) {
        win.restore();
    }
    if (!win.isVisible()) {
        win.show();
    }
    win.focus();
}

async function readWorkspace(workspaceId: string): Promise<Workspace> {
    if (!workspaceId) {
        return null;
    }
    try {
        return await WorkspaceService.GetWorkspace(workspaceId);
    } catch {
        return null;
    }
}

// The outcome decides: close skips window:confirmclose, cancel keeps the window, the others leave it to that setting.
export async function askWindowCloseStops(
    win: WaveBrowserWindow,
    numWindows: number,
    saveLastWindow: boolean
): Promise<string> {
    const workspace = await readWorkspace(win.workspaceId);
    const stops = windowCloseStops({
        numWindows,
        saveLastWindow,
        platform: unamePlatform,
        numBuilders: getAllBuilderWindows().length,
        workspace,
    });
    if (stops == null) {
        return BusyOutcomeNone;
    }
    return askOncePerAction(`window:${win.waveWindowId}`, () =>
        askBusyStop(windowTarget(win), BusyAskKindWindow, stops, { onAsking: () => bringForward(win) })
    );
}

// A switch has no Electron confirmation of its own: only a cancel in MoltenTerm's dialog stops it.
export async function askSwitchStops(
    win: WaveBrowserWindow,
    current: Workspace,
    targetHasWindow: boolean
): Promise<boolean> {
    const stops = switchStops(current, targetHasWindow);
    if (stops == null) {
        return true;
    }
    const outcome = await askOncePerAction(`switch:${win.waveWindowId}`, () =>
        askBusyStop(windowTarget(win), BusyAskKindSwitch, stops, { onAsking: () => bringForward(win) })
    );
    return outcome !== BusyOutcomeCancel;
}

// Asked in the renderer that asked for the delete (the rail, the edit sheet or the workspace switcher).
export async function askDeleteStops(sender: BusyAskTarget, workspaceId: string): Promise<string> {
    const workspace = await readWorkspace(workspaceId);
    return askOncePerAction(`delete:${workspaceId}`, () =>
        askBusyStop(
            sender,
            BusyAskKindDelete,
            { stopworkspaceids: [workspaceId], quit: false },
            { name: workspace?.name }
        )
    );
}

export async function askQuitStops(windows: WaveBrowserWindow[], focused: WaveBrowserWindow): Promise<string> {
    const live = (windows ?? []).filter((w) => w != null && !w.isDestroyed());
    const win = focused != null && live.includes(focused) ? focused : live[0];
    if (win == null) {
        return BusyOutcomeNone;
    }
    return askOncePerAction("quit", () =>
        askBusyStop(
            windowTarget(win),
            BusyAskKindQuit,
            { stopworkspaceids: [], quit: true },
            { name: app.getName(), onAsking: () => bringForward(win) }
        )
    );
}
