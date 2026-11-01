// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

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

const ClearViewBg = "#00000000";
// Dark in every system appearance, so the sidebar's light text stays readable over it.
const BlurVibrancy = "hud";

export type WindowLookSupport = { translucent: boolean; blur: boolean };
export type WindowLookRequest = { translucent: boolean; blur: boolean };

type CreatedLook = { transparent: boolean; blur: boolean; platform: string };

type LookWindow = {
    isDestroyed(): boolean;
    setVibrancy?(type: string | null): void;
};

type LookView = {
    setBackgroundColor(color: string): void;
};

const created = new WeakMap<object, CreatedLook>();
const requested = new WeakMap<object, WindowLookRequest>();

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
    return { translucent: v.translucent === true, blur: v.blur === true };
}

// What the window and the sending view become. The look is the only judge (#1629): window:blur is on by default, so a
// window keeping Wave's creation-time blur under an opaque look would turn a saved opaque workspace see-through.
export function applyWindowLook(
    win: LookWindow,
    view: LookView,
    isActiveView: boolean,
    look: CreatedLook,
    request: WindowLookRequest
): boolean {
    if (win == null || win.isDestroyed() || view == null || request == null) {
        return false;
    }
    const support = windowLookSupport(look);
    const translucent = request.translucent && support.translucent;
    const blur = translucent && request.blur && support.blur;
    view.setBackgroundColor(translucent ? ClearViewBg : opaqueBackground());
    if (!isActiveView || look?.platform !== "darwin") {
        return true;
    }
    win.setVibrancy?.(blur ? BlurVibrancy : null);    return true;
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
        return false;
    }
    return applyWindowLook(win, view, true, created.get(win), request);
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
