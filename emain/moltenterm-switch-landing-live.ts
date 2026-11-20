// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The end of a switch (#2419) on real views: the rules are in moltenterm-switch-landing.ts. The tab view host calls
// watchLandedView once a switch has put its view on screen; a newer landing of the same window replaces the watch.

import type { WaveTabView } from "./emain-tabview";
import type { WaveBrowserWindow } from "./emain-window";
import { isBackgroundMode } from "./moltenterm-background";
import { isFlatFrame } from "./moltenterm-carpet-thumb-store";
import {
    framePaints,
    LandingFrameWidthPx,
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

// One frame of the view, read back small. Only a window on screen draws frames to read.
async function paints(win: WaveBrowserWindow, view: WaveTabView): Promise<boolean> {
    if (win.isDestroyed() || !win.isVisible() || win.isMinimized() || !live(view)) {
        return null;
    }
    // A background test page (#495) draws only when read back: the first readback wakes it, the second holds its frame.
    if (isBackgroundMode()) {
        await view.webContents.capturePage();
    }
    const image = await view.webContents.capturePage();
    if (image.isEmpty()) {
        return false;
    }
    const small = image.resize({ width: LandingFrameWidthPx });
    return framePaints(small.toBitmap(), small.getSize(), (bitmap, size) =>
        isFlatFrame(Buffer.from(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength), size)
    );
}

// The view a switch just put on screen is checked once the switch has settled (moltenterm-switch-landing.ts).
export function watchLandedView(win: WaveBrowserWindow, view: WaveTabView) {
    watches.get(win)?.();
    watches.delete(win);
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
            cycleVisibility: () => {
                view.setVisible(false);
                view.setVisible(true);
            },
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
