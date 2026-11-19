// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

vi.mock("./emain-window", () => ({ getWaveWindowByWebContentsId: () => null }));
vi.mock("./emain-tabview", () => ({ getWaveTabViewByWebContentsId: () => null }));
vi.mock("./moltenterm-privileged-ipc", () => ({ onAppIpc: () => {}, handleAppIpc: () => {} }));
// The dark theme's opaque colour (moltenterm-theme.test.ts covers the light one).
vi.mock("./moltenterm-theme", () => ({ opaqueBackground: () => "#222222" }));

import {
    applyActiveViewLook,
    applyWindowLook,
    letViewThrough,
    LookFadeMs,
    noteWindowCreatedLook,
    parseLookRequest,
    receiveWindowLook,
    restoreViewBackground,
    viewLooksTranslucent,
    windowLookSupport,
} from "./moltenterm-window-look";

const Mac = { transparent: true, blur: false, platform: "darwin" };

function makeWindow(destroyed = false) {
    return { isDestroyed: () => destroyed, setVibrancy: vi.fn() };
}

function makeView() {
    return { setBackgroundColor: vi.fn() };
}

describe("a workspace's look in Electron main (FR-SHELL-091, DS-SHELL-131)", () => {
    it("lets the desktop through the sending view and blurs it with a dark material", () => {
        const win = makeWindow();
        const view = makeView();
        expect(applyWindowLook(win, view, true, Mac, { translucent: true, blur: true })).toBe(true);
        expect(view.setBackgroundColor).toHaveBeenCalledWith("#00000000");
        expect(win.setVibrancy).toHaveBeenCalledWith("hud");
    });

    it("goes back to today's opaque view and no vibrancy", () => {
        const win = makeWindow();
        const view = makeView();
        applyWindowLook(win, view, true, Mac, { translucent: false, blur: false });
        expect(view.setBackgroundColor).toHaveBeenCalledWith("#222222");
        expect(win.setVibrancy).toHaveBeenCalledWith(null);
    });

    it("rebuilds the window's vibrancy only when it changes, so a switch to a view with the same look flicks nothing (#2375)", () => {
        const win = makeWindow();
        applyWindowLook(win, makeView(), true, Mac, { translucent: true, blur: true });
        applyWindowLook(win, makeView(), true, Mac, { translucent: true, blur: true });
        applyWindowLook(win, makeView(), true, Mac, { translucent: true, blur: true });
        expect(win.setVibrancy).toHaveBeenCalledTimes(1);
        applyWindowLook(win, makeView(), true, Mac, { translucent: false, blur: false });
        expect(win.setVibrancy).toHaveBeenCalledTimes(2);
        expect(win.setVibrancy).toHaveBeenLastCalledWith(null);
        applyWindowLook(win, makeView(), true, Mac, { translucent: true, blur: true });
        expect(win.setVibrancy).toHaveBeenCalledTimes(3);
        // each window keeps its own: a second window gets its first call
        const other = makeWindow();
        applyWindowLook(other, makeView(), true, Mac, { translucent: true, blur: true });
        expect(other.setVibrancy).toHaveBeenCalledTimes(1);
    });

    it("tells which views asked to let the desktop through", () => {
        const win = makeWindow();
        const see = makeView();
        const flat = makeView();
        receiveWindowLook(win, see, false, Mac, { translucent: true, blur: false });
        receiveWindowLook(win, flat, false, Mac, { translucent: false, blur: false });
        expect(viewLooksTranslucent(see)).toBe(true);
        expect(viewLooksTranslucent(flat)).toBe(false);
        expect(viewLooksTranslucent(makeView())).toBe(false);
        expect(viewLooksTranslucent(null)).toBe(false);
    });

    it("makes an opaque look opaque even on a window created with a blur (#1629)", () => {
        const win = makeWindow();
        const view = makeView();
        applyWindowLook(win, view, true, { ...Mac, blur: true }, { translucent: false, blur: false });
        expect(view.setBackgroundColor).toHaveBeenCalledWith("#222222");
        expect(win.setVibrancy).toHaveBeenCalledWith(null);
    });

    it("lets a view off screen set only its own background, never the window's blur", () => {
        const win = makeWindow();
        const view = makeView();
        applyWindowLook(win, view, false, Mac, { translucent: true, blur: true });
        expect(view.setBackgroundColor).toHaveBeenCalledWith("#00000000");
        expect(win.setVibrancy).not.toHaveBeenCalled();
    });

    it("keeps a window that was not created transparent opaque", () => {
        const win = makeWindow();
        const view = makeView();
        const linux = { transparent: false, blur: false, platform: "linux" };
        applyWindowLook(win, view, true, linux, { translucent: true, blur: true });
        expect(view.setBackgroundColor).toHaveBeenCalledWith("#222222");
        expect(win.setVibrancy).not.toHaveBeenCalled();
    });

    it("reports what each window can do: see-through if created transparent, blur on macOS only", () => {
        expect(windowLookSupport(Mac)).toEqual({ translucent: true, blur: true });
        expect(windowLookSupport({ transparent: true, blur: false, platform: "win32" })).toEqual({
            translucent: true,
            blur: false,
        });
        expect(windowLookSupport({ transparent: false, blur: false, platform: "linux" })).toEqual({
            translucent: false,
            blur: false,
        });
        expect(windowLookSupport(null)).toEqual({ translucent: false, blur: false });
    });

    it("reads only booleans that are exactly true, and ignores a missing or closed window", () => {
        expect(parseLookRequest({ translucent: "yes", blur: 1 })).toEqual({ translucent: false, blur: false });
        expect(parseLookRequest(null)).toBeNull();
        expect(applyWindowLook(null, makeView(), true, Mac, { translucent: true, blur: false })).toBe(false);
        expect(applyWindowLook(makeWindow(true), makeView(), true, Mac, { translucent: true, blur: false })).toBe(
            false
        );
    });
});

// #1711: the window's blur after a switch is the shown view's, whatever the order the views' requests came in.
describe("a workspace switch and the window's blur (#1711)", () => {
    const Blur = { translucent: true, blur: true };
    const Opaque = { translucent: false, blur: false };

    function makeMacWindow() {
        const win = makeWindow();
        noteWindowCreatedLook(win, true, false, "darwin");
        return win;
    }

    function lastVibrancy(win: ReturnType<typeof makeWindow>) {
        return win.setVibrancy.mock.lastCall?.[0];
    }

    it("gives the window the blur of a view coming back on screen that sends nothing more", () => {
        const win = makeMacWindow();
        const opaqueWs = makeView();
        const blurredWs = makeView();
        receiveWindowLook(win, blurredWs, false, Mac, Blur);
        receiveWindowLook(win, opaqueWs, true, Mac, Opaque);
        expect(lastVibrancy(win)).toBeNull();
        applyActiveViewLook(win, blurredWs);
        expect(lastVibrancy(win)).toBe("hud");
    });

    it("keeps the last switch's look when a view left behind sends late", () => {
        const win = makeMacWindow();
        const a = makeView();
        const b = makeView();
        const c = makeView();
        receiveWindowLook(win, c, false, Mac, Blur);
        receiveWindowLook(win, a, true, Mac, Blur);
        // b comes on screen while its look still reads opaque, and the user moves on to c before b sends its blur
        applyActiveViewLook(win, b);
        receiveWindowLook(win, b, true, Mac, Opaque);
        applyActiveViewLook(win, c);
        receiveWindowLook(win, b, false, Mac, Blur);
        expect(lastVibrancy(win)).toBe("hud");
        expect(c.setBackgroundColor).toHaveBeenLastCalledWith("#00000000");
    });

    it("leaves the window alone for a view that has not asked for a look yet", () => {
        const win = makeMacWindow();
        expect(applyActiveViewLook(win, makeView())).toBe(false);
        expect(win.setVibrancy).not.toHaveBeenCalled();
    });
});

// #2390: a switch never snaps the look or drops a frame.
describe("a switch between looks (#2390)", () => {
    const Blur = { translucent: true, blur: true };
    const Clear = { translucent: true, blur: false };
    const Opaque = { translucent: false, blur: false };

    function makeMacWindow() {
        const win = makeWindow();
        noteWindowCreatedLook(win, true, false, "darwin");
        return win;
    }

    it("fades the window's blur in or out with the switch, in the switch's cross-fade time", () => {
        const win = makeMacWindow();
        const a = makeView();
        const b = makeView();
        receiveWindowLook(win, a, true, Mac, Clear);
        receiveWindowLook(win, b, false, Mac, Blur);
        applyActiveViewLook(win, b);
        expect(win.setVibrancy).toHaveBeenLastCalledWith("hud", { animationDuration: LookFadeMs });
        expect(LookFadeMs).toBe(180);
        applyActiveViewLook(win, a);
        expect(win.setVibrancy).toHaveBeenLastCalledWith(null, { animationDuration: LookFadeMs });
    });

    it("changes the blur at once under reduced motion, and for a change of the look on screen", () => {
        const win = makeMacWindow();
        const a = makeView();
        const b = makeView();
        receiveWindowLook(win, a, true, Mac, Clear);
        receiveWindowLook(win, b, false, Mac, { ...Blur, reducedMotion: true });
        applyActiveViewLook(win, b);
        expect(win.setVibrancy).toHaveBeenLastCalledWith("hud");
        // the sheet's slider on the view on screen
        receiveWindowLook(win, b, true, Mac, Clear);
        expect(win.setVibrancy).toHaveBeenLastCalledWith(null);
    });

    it("sets a view's background only when it changes, so the view on screen never drops its frame", () => {
        const win = makeMacWindow();
        const v = makeView();
        receiveWindowLook(win, v, true, Mac, Blur);
        receiveWindowLook(win, v, true, Mac, Blur);
        applyActiveViewLook(win, v);
        applyActiveViewLook(win, v);
        expect(v.setBackgroundColor).toHaveBeenCalledTimes(1);
        receiveWindowLook(win, v, true, Mac, Opaque);
        expect(v.setBackgroundColor).toHaveBeenCalledTimes(2);
        expect(v.setBackgroundColor).toHaveBeenLastCalledWith("#222222");
    });

    it("reads the page's reduced-motion rule only when it is exactly true", () => {
        expect(parseLookRequest({ translucent: true, blur: true, reducedMotion: true })).toEqual({
            translucent: true,
            blur: true,
            reducedMotion: true,
        });
        expect(parseLookRequest({ translucent: true, blur: true, reducedMotion: "yes" })).toEqual({
            translucent: true,
            blur: true,
        });
    });

    it("lets an opaque view being left through for the cross-fade, and gives its background back", () => {
        const win = makeMacWindow();
        const v = makeView();
        receiveWindowLook(win, v, true, Mac, Opaque);
        expect(letViewThrough(win, v)).toBe(true);
        expect(v.setBackgroundColor).toHaveBeenLastCalledWith("#00000000");
        restoreViewBackground(win, v);
        expect(v.setBackgroundColor).toHaveBeenLastCalledWith("#222222");
        // coming back on screen with a later switch restores it too
        letViewThrough(win, v);
        applyActiveViewLook(win, v);
        expect(v.setBackgroundColor).toHaveBeenLastCalledWith("#222222");
        // a view that never asked for a look goes back to opaque
        const fresh = makeView();
        letViewThrough(win, fresh);
        restoreViewBackground(win, fresh);
        expect(fresh.setBackgroundColor).toHaveBeenLastCalledWith("#222222");
    });

    it("never lets a view through on a window that cannot be see-through", () => {
        const win = makeWindow();
        noteWindowCreatedLook(win, false, false, "linux");
        const v = makeView();
        expect(letViewThrough(win, v)).toBe(false);
        expect(v.setBackgroundColor).not.toHaveBeenCalled();
        expect(letViewThrough(makeWindow(true), v)).toBe(false);
    });
});
