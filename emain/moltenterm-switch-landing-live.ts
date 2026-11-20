// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The end of a switch (#2419) on real views: the rules are in moltenterm-switch-landing.ts. The tab view host calls
// watchLandedView once a switch has put its view on screen; a switch that starts, a newer landing and the window's
// close stop the watch.

import type { WaveTabView } from "./emain-tabview";
import type { WaveBrowserWindow } from "./emain-window";
import { isBackgroundMode } from "./moltenterm-background";
import {
    framePaints,
    LandingBandHeightPx,
    LandingMainState,
    LandingPageReport,
    landingProbeScript,
    restoreLandingScript,
    watchSwitchLanding,
} from "./moltenterm-switch-landing";
import { revealTabView } from "./moltenterm-tabview-budget";
import { positionWindowTabViews, windowTabViews } from "./moltenterm-tabview-host";
import { ClearViewBg, restoreViewBackground, viewBackgroundState } from "./moltenterm-window-look";

// MOLTENTERM_SWITCHLANDING=0 turns the check off, for a build under test.
function enabled(): boolean {
    return process.env.MOLTENTERM_SWITCHLANDING !== "0";
}

const watches = new WeakMap<WaveBrowserWindow, () => void>();

function live(view: WaveTabView): boolean {
    return view != null && !view.isDestroyed && !view.webContents.isDestroyed();
}

function onScreen(win: WaveBrowserWindow, view: WaveTabView): boolean {
    const b = view.getBounds();
    const w = win.getContentBounds();
    return b.x == 0 && b.y == 0 && b.width == w.width && b.height == w.height;
}

function mainState(win: WaveBrowserWindow, view: WaveTabView): LandingMainState {
    let covered = false;
    for (const other of windowTabViews(win.waveWindowId).values()) {
        if (other === view || !live(other) || !win.contentView.children.includes(other)) {
            continue;
        }
        const b = other.getBounds();
        if (b.x == 0 && b.y == 0 && b.width > 0 && b.height > 0 && other.getVisible()) {
            covered = true;
        }
    }
    const look = viewBackgroundState(win, view);
    return {
        inWindow: win.contentView.children.includes(view),
        onScreen: onScreen(win, view),
        visible: view.getVisible(),
        covered,
        background: look.background,
        wantsClear: look.wantsClear,
        windowShows: windowShowsFrames(win),
    };
}

// A background test window (#495) is parked mostly off screen: its pages are hidden by the system, which says nothing.
function windowShowsFrames(win: WaveBrowserWindow): boolean {
    return !isBackgroundMode() && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused();
}

function restoreMain(win: WaveBrowserWindow, view: WaveTabView) {
    if (win.isDestroyed() || !live(view)) {
        return;
    }
    if (!win.contentView.children.includes(view)) {
        win.contentView.addChildView(view);
    }
    revealTabView(view);
    positionWindowTabViews(win);
    if (!view.getVisible()) {
        view.setVisible(true);
    }
    restoreViewBackground(win, view);
}

// A thin band of the view's frame, across its whole width at mid-height (the sidebar and the panels): the rules only ask
// whether anything is painted, and a whole frame would cost megabytes at every switch.
export function landingBand(bounds: { width: number; height: number }) {
    const height = Math.min(LandingBandHeightPx, Math.max(1, bounds.height));
    return {
        x: 0,
        y: Math.max(0, Math.round(bounds.height / 2 - height / 2)),
        width: Math.max(1, bounds.width),
        height,
    };
}

async function paints(win: WaveBrowserWindow, view: WaveTabView): Promise<boolean> {
    if (win.isDestroyed() || !live(view)) {
        return null;
    }
    const image = await view.webContents.capturePage(landingBand(view.getBounds()));
    if (image == null || image.isEmpty()) {
        return null;
    }
    return framePaints(image.toBitmap(), image.getSize());
}

// A visibility cycle can take the keyboard focus from the view: it gets it back if it had it.
function cycleVisibility(view: WaveTabView) {
    const focused = view.webContents.isFocused();
    view.setVisible(false);
    view.setVisible(true);
    if (focused && !view.webContents.isFocused()) {
        view.webContents.focus();
    }
}

// A switch that starts (its picture shown, or its action queued) and the window's close stop the watch of the last
// landing: the check never touches a view a newer switch uses (#2419).
export function cancelLandingWatch(win: WaveBrowserWindow) {
    watches.get(win)?.();
    watches.delete(win);
}

// The view a switch just put on screen is checked once the switch has settled (moltenterm-switch-landing.ts).
export function watchLandedView(win: WaveBrowserWindow, view: WaveTabView) {
    cancelLandingWatch(win);
    if (!enabled() || win.isDestroyed() || !live(view)) {
        return;
    }
    const tabId = view.waveTabId;
    const cancel = watchSwitchLanding(
        tabId,
        {
            setTimer: (fn, ms) => setTimeout(fn, ms),
            clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
            log: (msg) => console.log(msg),
            stillLanded: () => !win.isDestroyed() && win.activeTabView === view && live(view),
            busy: () => win.actionQueue.length > 0,
            mainState: () => mainState(win, view),
            restoreMain: () => restoreMain(win, view),
            probePage: () =>
                Promise.resolve().then(
                    () => view.webContents.executeJavaScript(landingProbeScript()) as Promise<LandingPageReport>
                ),
            restorePage: () => Promise.resolve().then(() => view.webContents.executeJavaScript(restoreLandingScript())),
            paints: () => paints(win, view),
            cycleVisibility: () => cycleVisibility(view),
            clearBackground: ClearViewBg,
        },
        () => {
            if (watches.get(win) === cancel) {
                watches.delete(win);
            }
        }
    );
    watches.set(win, cancel);
}
