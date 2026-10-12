// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { fireAndForget } from "@/util/util";
import { powerMonitor } from "electron";
import type { WaveTabView } from "./emain-tabview";
import { isBackgroundMode } from "./moltenterm-background";
import { ensureTabViewPainted, ShownViewProbe, ShownViewProbeScript } from "./moltenterm-tabview-health";
import { destroyTabView, isTabViewHostEnabled } from "./moltenterm-tabview-host";

// A probe finding no frames only counts if the user used the machine this recently: a display that went to sleep
// while the window kept the focus stops every frame too (#461).
export const PaintCheckRecentInputSec = 30;
// A deferred check looks again this often (besides the window's next focus) while its view stays shown.
export const DeferredPaintCheckRetryMs = 10 * 1000;

type WindowShowingTabViews = {
    readonly activeTabView: WaveTabView;
    readonly actionQueue: { readonly length: number };
    isDestroyed(): boolean;
    isFocused(): boolean;
    isMinimized(): boolean;
    isVisible(): boolean;
    once(event: "focus", listener: () => void): unknown;
    removeListener(event: "focus", listener: () => void): unknown;
    setActiveTab(tabId: string, setInBackend: boolean): Promise<void>;
};

const leftScreenAt = new WeakMap<WaveTabView, number>();
// One deferred check per view: showing it again, or it leaving the screen, cancels the one waiting.
const deferredChecks = new WeakMap<WaveTabView, () => void>();

function cancelDeferredPaintCheck(tabView: WaveTabView) {
    deferredChecks.get(tabView)?.();
}

export function noteTabViewLeftScreen(tabView: WaveTabView) {
    if (tabView == null) {
        return;
    }
    cancelDeferredPaintCheck(tabView);
    leftScreenAt.set(tabView, Date.now());
}

// A hidden view kept through a wake (#375) gets the visibility cycle when it is next shown, however short its hidden
// time looks: the sleep may have dropped its frame.
export function noteTabViewNeedsRepaint(tabView: WaveTabView) {
    if (tabView == null) {
        return;
    }
    leftScreenAt.set(tabView, 0);
}

// Whether the window can show frames at all, so that a view without frames is the view's fault (#461): visible, not
// minimised, focused (a focused window is not covered by another one) and in use. And idle: while an action runs, the
// view on screen may be the one it is about to replace, and a rebuild would race it.
// In the background test mode (#495) the focus is virtual and the instance is driven through CDP, not by the user's
// input, so recent input is not asked for: the parked window floats above the others and cannot be covered. A locked
// screen still stops every frame, so it still defers.
export function windowCanShowFrames(
    win: WindowShowingTabViews,
    systemIdleSec: number,
    background = isBackgroundMode(),
    screenLocked = false
): boolean {
    return (
        !win.isDestroyed() &&
        win.actionQueue.length === 0 &&
        win.isVisible() &&
        !win.isMinimized() &&
        win.isFocused() &&
        (background ? !screenLocked : systemIdleSec < PaintCheckRecentInputSec)
    );
}

// See moltenterm-tabview-health.ts (#223). Runs once a reused view is on screen (the tab view host calls it as the view
// becomes shown again), so a healthy switch is not delayed.
export function checkReusedTabViewPainted(win: WindowShowingTabViews, tabView: WaveTabView) {
    cancelDeferredPaintCheck(tabView);
    const leftAt = leftScreenAt.get(tabView);
    leftScreenAt.delete(tabView);
    runPaintCheck(win, tabView, leftAt == null ? 0 : Date.now() - leftAt, false);
}

function canJudge(win: WindowShowingTabViews): boolean {
    if (!isTabViewHostEnabled()) {
        return true;
    }
    const background = isBackgroundMode();
    const locked = background && powerMonitor.getSystemIdleState(PaintCheckRecentInputSec) === "locked";
    return windowCanShowFrames(win, powerMonitor.getSystemIdleTime(), background, locked);
}

function runPaintCheck(win: WindowShowingTabViews, tabView: WaveTabView, hiddenForMs: number, deferredBefore: boolean) {
    const isLive = () => !win.isDestroyed() && win.activeTabView === tabView && !tabView.isDestroyed;
    fireAndForget(async () => {
        const result = await ensureTabViewPainted({
            isLive,
            hiddenForMs: () => hiddenForMs,
            probe: () => tabView.webContents.executeJavaScript(ShownViewProbeScript) as Promise<ShownViewProbe>,
            cycleVisibility: () => {
                tabView.setVisible(false);
                tabView.setVisible(true);
            },
            rebuild: () => rebuildActiveTabView(win, tabView),
            log: (msg) => console.log(msg, tabView.waveTabId),
            canJudge: () => canJudge(win),
        });
        if (result === "deferred") {
            if (!deferredBefore) {
                console.log(
                    "[#461] reused tab view shows no frames while its window cannot show it (unfocused, minimised, hidden or idle): check deferred",
                    tabView.waveTabId
                );
            }
            deferPaintCheck(win, tabView, isLive);
            return;
        }
        if (result !== "rendering" && result !== "skipped") {
            console.log("reused tab view", result, tabView.waveTabId);
        }
    });
}

// Runs the check again at the window's next focus, or when a periodic look finds the window able to show frames, as
// long as the view stays shown.
function deferPaintCheck(win: WindowShowingTabViews, tabView: WaveTabView, isLive: () => boolean) {
    cancelDeferredPaintCheck(tabView);
    let timer: ReturnType<typeof setTimeout> = null;
    const stop = () => {
        clearTimeout(timer);
        win.removeListener("focus", onFocus);
        if (deferredChecks.get(tabView) === stop) {
            deferredChecks.delete(tabView);
        }
    };
    const retry = () => {
        stop();
        if (isLive()) {
            runPaintCheck(win, tabView, 0, true);
        }
    };
    const onFocus = () => retry();
    const look = () => {
        if (!isLive()) {
            stop();
            return;
        }
        if (canJudge(win)) {
            retry();
            return;
        }
        timer = setTimeout(look, DeferredPaintCheckRetryMs);
    };
    deferredChecks.set(tabView, stop);
    win.once("focus", onFocus);
    timer = setTimeout(look, DeferredPaintCheckRetryMs);
}

// Durable terminals run outside the views, so a fresh view reattaches them as after #199's eviction. Destroying the
// shown view leaves the window without an active view (the tab view host), so the tab is loaded again from the spare.
async function rebuildActiveTabView(win: WindowShowingTabViews, tabView: WaveTabView) {
    const tabId = tabView.waveTabId;
    destroyTabView(tabView, "paint check: it does not render (#223)");
    await win.setActiveTab(tabId, false);
}
