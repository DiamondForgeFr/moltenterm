// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A workspace's look (FR-SHELL-091, DS-SHELL-131, #1281): the page draws the frame's opacity with CSS alpha and tells
// Electron main only whether its view must let the desktop through and whether the window blurs it. A window can be
// see-through only if it was created transparent: on macOS every window is (emain-window.ts), elsewhere only when
// window:transparent was on at its creation. The blur is a vibrancy, macOS only, changed at runtime. Only the window's
// own tab views are heard, and only the view on screen changes the window's vibrancy; each view sends again when it
// comes on screen, so the look follows the workspace shown.

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

// What the window and the sending view become. A window created with Wave's global blur keeps it when the look is
// opaque; a window created with window:transparent keeps its views clear, as Wave draws them.
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
    view.setBackgroundColor(translucent || look?.blur ? ClearViewBg : opaqueBackground());
    if (!isActiveView || look?.platform !== "darwin") {
        return true;
    }
    if (blur) {
        win.setVibrancy?.(BlurVibrancy);
    } else {
        win.setVibrancy?.(look?.blur ? "fullscreen-ui" : null);
    }
    return true;
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
        applyWindowLook(win, view, win.activeTabView === view, created.get(win), parseLookRequest(value));
    });
}
