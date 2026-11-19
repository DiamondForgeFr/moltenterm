// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A workspace's look (FR-SHELL-091, DS-SHELL-131, #1281): the page draws the frame's opacity with CSS alpha and tells
// Electron main only whether its view must let the desktop through and whether the window blurs it. A window can be
// see-through only if it was created transparent: on macOS every window is (emain-window.ts), elsewhere only when
// window:transparent was on at its creation. The blur is a vibrancy, macOS only, changed at runtime. Only the window's
// own tab views are heard, and only the view on screen changes the window's vibrancy. Each view's last request is kept
// and applied to the window when that view becomes the active one (#1711): a switch never depends on the view sending
// again once it is on screen, and a request from a view already left (a fast switch) never lands on the window.

import { getWaveTabViewByWebContentsId } from "./emain-tabview";
import { getWaveWindowByWebContentsId } from "./emain-window";
import { handleAppIpc, onAppIpc } from "./moltenterm-privileged-ipc";
import { opaqueBackground } from "./moltenterm-theme";

export const WindowLookChannel = "moltenterm-window-look";
export const WindowLookSupportChannel = "moltenterm-window-look-support";

export const ClearViewBg = "#00000000";
// Dark in every system appearance, so the sidebar's light text stays readable over it.
const BlurVibrancy = "hud";
// The window's blur fades in or out with a switch in --mt-duration-base (frontend/moltenterm-shell/tokens.css), the
// switch picture's cross-fade (#2390): a switch between two looks moves from one to the other with the motion, never in
// one frame.
export const LookFadeMs = 180;

export type WindowLookSupport = { translucent: boolean; blur: boolean };
// reducedMotion: the page's own reduced-motion rule (the app's setting or the system's), so the blur changes at once.
export type WindowLookRequest = { translucent: boolean; blur: boolean; reducedMotion?: boolean };

type CreatedLook = { transparent: boolean; blur: boolean; platform: string };

type LookWindow = {
    isDestroyed(): boolean;
    setVibrancy?(type: string | null, options?: { animationDuration?: number }): void;
};

type LookView = {
    setBackgroundColor(color: string): void;
};

const created = new WeakMap<object, CreatedLook>();
const requested = new WeakMap<object, WindowLookRequest>();
const appliedVibrancy = new WeakMap<object, string | null>();
const appliedBackground = new WeakMap<object, string>();

// A view's background is set only when it changes: Chromium drops the frame a view on screen shows when its background
// is set, and the window showed one empty frame (the bare blur) at a switch (#2390).
export function setViewBackground(view: LookView, color: string) {
    if (view == null || appliedBackground.get(view) === color) {
        return;
    }
    appliedBackground.set(view, color);
    view.setBackgroundColor(color);
}

function setWindowVibrancy(win: LookWindow, vibrancy: string | null, animate: boolean) {
    // Only a change reaches the window: setVibrancy rebuilds the window's effect view, and doing it at every switch
    // flicked the view that had just come on screen (a hidden then visible cycle 3 ms after the swap, #2375).
    if (appliedVibrancy.has(win) && appliedVibrancy.get(win) === vibrancy) {
        return;
    }
    appliedVibrancy.set(win, vibrancy);
    if (animate) {
        win.setVibrancy?.(vibrancy, { animationDuration: LookFadeMs });
        return;
    }
    win.setVibrancy?.(vibrancy);
}

export function noteWindowCreatedLook(win: object, transparent: boolean, blur: boolean, platform: string) {
    created.set(win, { transparent, blur, platform });
}

export function windowLookSupport(look: CreatedLook): WindowLookSupport {
    if (look == null) {
        return { translucent: false, blur: false };
    }
    return { translucent: look.transparent, blur: look.transparent && look.platform === "darwin" };
}

export function parseLookRequest(value: unknown): WindowLookRequest {
    if (value == null || typeof value !== "object") {
        return null;
    }
    const v = value as Record<string, unknown>;
    const request: WindowLookRequest = { translucent: v.translucent === true, blur: v.blur === true };
    if (v.reducedMotion === true) {
        request.reducedMotion = true;
    }
    return request;
}

// What the window and the sending view become. The look is the only judge (#1629): window:blur is on by default, so a
// window keeping Wave's creation-time blur under an opaque look would turn a saved opaque workspace see-through.
// switching: the view comes on screen with a switch, so the window's blur fades with the motion (#2390); a change of
// the look on screen (the sheet's slider) is drawn at once.
export function applyWindowLook(
    win: LookWindow,
    view: LookView,
    isActiveView: boolean,
    look: CreatedLook,
    request: WindowLookRequest,
    switching = false
): boolean {
    if (win == null || win.isDestroyed() || view == null || request == null) {
        return false;
    }
    const support = windowLookSupport(look);
    const translucent = request.translucent && support.translucent;
    const blur = translucent && request.blur && support.blur;
    setViewBackground(view, translucent ? ClearViewBg : opaqueBackground());
    if (!isActiveView || look?.platform !== "darwin") {
        return true;
    }
    setWindowVibrancy(win, blur ? BlurVibrancy : null, switching && request.reducedMotion !== true);
    return true;
}

// The view being left by a switch to a see-through workspace lets the desktop through while its own content fades
// under the target's picture, so the window turns see-through with the cross-fade instead of at the swap (#2390). Only
// its background changes: its page keeps drawing what it drew.
export function letViewThrough(win: LookWindow, view: LookView): boolean {
    if (win == null || win.isDestroyed() || view == null || !windowLookSupport(created.get(win)).translucent) {
        return false;
    }
    setViewBackground(view, ClearViewBg);
    return true;
}

// The view a switch left on screen after all (the switch was cancelled) takes its own background back.
export function restoreViewBackground(win: LookWindow, view: LookView) {
    if (win == null || win.isDestroyed() || view == null) {
        return;
    }
    const request = requested.get(view);
    const translucent = request?.translucent === true && windowLookSupport(created.get(win)).translucent;
    setViewBackground(view, translucent ? ClearViewBg : opaqueBackground());
}

// Whether a view asked to let the desktop through: no picture of it can be drawn over what shows behind (#2375).
export function viewLooksTranslucent(view: object): boolean {
    return view != null && requested.get(view)?.translucent === true;
}

// A view's request, kept for when it comes on screen, and applied now.
export function receiveWindowLook(
    win: LookWindow,
    view: LookView,
    isActiveView: boolean,
    look: CreatedLook,
    request: WindowLookRequest
): boolean {
    if (view == null || request == null) {
        return false;
    }
    requested.set(view, request);
    return applyWindowLook(win, view, isActiveView, look, request);
}

// The view that just became the window's active one brings its own look: the window's vibrancy is the shown view's,
// whatever the views left on the way sent. A view that has not asked yet keeps its opaque creation background.
export function applyActiveViewLook(win: LookWindow, view: LookView): boolean {
    if (win == null || view == null) {
        return false;
    }
    const request = requested.get(view);
    if (request == null) {
        // a view let through for a switch it left before it ever asked for a look comes back opaque (#2390)
        if (appliedBackground.get(view) === ClearViewBg && !win.isDestroyed()) {
            setViewBackground(view, opaqueBackground());
        }
        return false;
    }
    return applyWindowLook(win, view, true, created.get(win), request, true);
}

let initialized = false;

export function initMoltentermWindowLook() {
    if (initialized) return;
    initialized = true;
    handleAppIpc(WindowLookSupportChannel, (event) => {
        const win = getWaveWindowByWebContentsId(event.sender.id);
        return windowLookSupport(win == null ? null : created.get(win));
    });
    onAppIpc(WindowLookChannel, (event, value: unknown) => {
        const win = getWaveWindowByWebContentsId(event.sender.id);
        const view = getWaveTabViewByWebContentsId(event.sender.id);
        if (win == null || view == null) {
            return;
        }
        receiveWindowLook(win, view, win.activeTabView === view, created.get(win), parseLookRequest(value));
    });
}
