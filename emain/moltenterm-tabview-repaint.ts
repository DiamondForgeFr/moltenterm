// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { fireAndForget } from "@/util/util";
import type { WaveTabView } from "./emain-tabview";
import { ensureTabViewPainted, ShownViewProbe, ShownViewProbeScript } from "./moltenterm-tabview-health";

type WindowShowingTabViews = {
    activeTabView: WaveTabView;
    isDestroyed(): boolean;
    removeTabView(tabId: string, force: boolean): void;
    setActiveTab(tabId: string, setInBackend: boolean): Promise<void>;
};

const leftScreenAt = new WeakMap<WaveTabView, number>();

export function noteTabViewLeftScreen(tabView: WaveTabView) {
    if (tabView == null) {
        return;
    }
    leftScreenAt.set(tabView, Date.now());
}

// See moltenterm-tabview-health.ts (#223). Runs once a reused view is on screen, so a healthy switch is not delayed.
export function checkReusedTabViewPainted(win: WindowShowingTabViews, tabView: WaveTabView) {
    const leftAt = leftScreenAt.get(tabView);
    leftScreenAt.delete(tabView);
    fireAndForget(async () => {
        const result = await ensureTabViewPainted({
            isLive: () => !win.isDestroyed() && win.activeTabView === tabView && !tabView.isDestroyed,
            hiddenForMs: () => (leftAt == null ? 0 : Date.now() - leftAt),
            probe: () => tabView.webContents.executeJavaScript(ShownViewProbeScript) as Promise<ShownViewProbe>,
            cycleVisibility: () => {
                tabView.setVisible(false);
                tabView.setVisible(true);
            },
            rebuild: () => rebuildActiveTabView(win, tabView),
            log: (msg) => console.log(msg, tabView.waveTabId),
        });
        if (result !== "rendering" && result !== "skipped") {
            console.log("reused tab view", result, tabView.waveTabId);
        }
    });
}

// Durable terminals run outside the views, so a fresh view reattaches them as after #199's eviction.
async function rebuildActiveTabView(win: WindowShowingTabViews, tabView: WaveTabView) {
    const tabId = tabView.waveTabId;
    win.removeTabView(tabId, true);
    if (win.activeTabView === tabView) {
        win.activeTabView = null;
    }
    await win.setActiveTab(tabId, false);
}
