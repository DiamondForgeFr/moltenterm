// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Switching workspace without the whole window flashing (#68). Wave destroyed every tab view of the window on a
// workspace switch and attached the next one before it had rendered: the rail, tab bar and status bar were rebuilt in
// front of the user. Moltenterm keeps the views of the workspace left (they go off-screen like inactive tabs, in the
// same cache) and shows the next view only once it is ready, so only the content changes.

import type { WaveTabView } from "./emain-tabview";
import { getWaveTabView } from "./emain-tabview";

// A reused view reinitialises in tens of milliseconds; past this, it is shown anyway.
export const MoltentermReinitTimeoutMs = 400;
// A new view boots a whole renderer; past this, it is shown anyway rather than leaving the user on the old workspace.
export const MoltentermFirstRenderTimeoutMs = 5000;

export function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> = null;
    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The renderer reports "wave-ready" after every init (emain-ipc.ts calls waveReadyResolve each time); a fresh promise
// catches the report of the reinit about to be sent.
export function nextWaveReady(tabView: WaveTabView): Promise<void> {
    return new Promise<void>((resolve) => {
        tabView.waveReadyResolve = resolve;
    });
}

// Wave deletes the workspace a window leaves when it is unsaved (no name or icon): its views are closed once the next
// workspace is on screen. A saved workspace keeps its views, so coming back is instant.
export function tabViewsToCloseOnLeave(left: Workspace): string[] {
    if (left == null || (left.name && left.icon)) {
        return [];
    }
    return left.tabids ?? [];
}

type WindowWithTabViews = {
    waveWindowId: string;
    removeTabView(tabId: string, force: boolean): void;
};

// A view kept by a window after a workspace switch belongs to that window; when the workspace opens in another
// window, the kept view is closed so the other window builds its own.
export function releaseTabViewFromOtherWindow(
    tabId: string,
    waveWindowId: string,
    findWindow: (id: string) => WindowWithTabViews
): void {
    const tabView = getWaveTabView(tabId);
    if (tabView == null || tabView.waveWindowId === waveWindowId) {
        return;
    }
    const owner = findWindow(tabView.waveWindowId);
    if (owner != null) {
        owner.removeTabView(tabId, true);
        return;
    }
    tabView.destroy();
}
