// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("./emain-window", () => ({ getWaveWindowByWebContentsId: () => null }));
vi.mock("./emain-tabview", () => ({ getWaveTabViewByWebContentsId: () => null }));
vi.mock("./moltenterm-privileged-ipc", () => ({ onAppIpc: () => {}, handleAppIpc: () => {} }));
// The dark theme's opaque colour (moltenterm-theme.test.ts covers the light one).
vi.mock("./moltenterm-theme", () => ({ opaqueBackground: () => "#222222" }));

import {
    applyActiveViewLook,
    applyWindowLook,
    noteWindowCreatedLook,
    parseLookRequest,
    receiveWindowLook,
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
