// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { clearTabCache, discardHotSpareTab } from "./emain-tabview";
import { getAllWaveWindows } from "./emain-window";

// After a long sleep, the tab views Electron keeps hidden in the cache are no longer repainted: showing one again
// (switching workspace or tab) gives an empty window until a reload (#199). Their websockets reconnect fine, so the
// cure is to drop them: the next switch builds a fresh view, about a second, and durable terminals are untouched
// since they run outside the views. The shown views are kept and asked to repaint.
export function refreshTabViewsAfterWake(reason: string) {
    console.log("refreshing tab views after", reason);
    clearTabCache();
    discardHotSpareTab();
    for (const ww of getAllWaveWindows()) {
        if (ww.isDestroyed()) {
            continue;
        }
        const tabView = ww.activeTabView;
        if (tabView?.webContents == null || tabView.webContents.isDestroyed()) {
            continue;
        }
        tabView.webContents.invalidate();
    }
}
