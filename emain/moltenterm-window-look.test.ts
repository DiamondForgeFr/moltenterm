// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("./emain-window", () => ({ getWaveWindowByWebContentsId: () => null }));
vi.mock("./emain-tabview", () => ({ getWaveTabViewByWebContentsId: () => null }));
vi.mock("./moltenterm-privileged-ipc", () => ({ onAppIpc: () => {}, handleAppIpc: () => {} }));

import { applyWindowLook, parseLookRequest, windowLookSupport } from "./moltenterm-window-look";

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

    it("keeps the blur of a window created with Wave's global blur when the look is opaque", () => {
        const win = makeWindow();
        const view = makeView();
        applyWindowLook(win, view, true, { ...Mac, blur: true }, { translucent: false, blur: false });
        expect(view.setBackgroundColor).toHaveBeenCalledWith("#00000000");
        expect(win.setVibrancy).toHaveBeenCalledWith("fullscreen-ui");
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
