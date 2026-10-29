// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("./emain-window", () => ({ getWaveWindowByWebContentsId: () => null }));
vi.mock("./moltenterm-privileged-ipc", () => ({ onAppIpc: () => {} }));

import {
    controlsOverlayHeight,
    DefaultControlsOverlayPx,
    macButtonDiscs,
    macButtonsPosition,
} from "../frontend/moltenterm-shell/sidebar/window-corner-model";
import { applyWindowButtons } from "./moltenterm-window-buttons";

function makeWindow(destroyed = false) {
    return {
        isDestroyed: () => destroyed,
        setWindowButtonVisibility: vi.fn(),
        setWindowButtonPosition: vi.fn(),
        setTitleBarOverlay: vi.fn(),
    };
}

describe("the window buttons follow the sidebar (DS-SHELL-127, #1279)", () => {
    it("hides and shows them on macOS, on the window row's centre line", () => {
        const win = makeWindow();
        expect(applyWindowButtons(win, { visible: false, zoom: 1 }, "darwin")).toBe(true);
        expect(applyWindowButtons(win, { visible: true, zoom: 1.5 }, "darwin")).toBe(true);
        expect(win.setWindowButtonVisibility.mock.calls).toEqual([[false], [true]]);
        expect(win.setWindowButtonPosition.mock.calls).toEqual([
            [macButtonsPosition(1)],
            [macButtonsPosition(1)],
            [macButtonsPosition(1.5)],
            [macButtonsPosition(1.5)],
        ]);
        expect(win.setTitleBarOverlay).not.toHaveBeenCalled();
    });

    it("places them inside the floating sidebar from the frame margin the page sends (#1293)", () => {
        const win = makeWindow();
        applyWindowButtons(win, { visible: true, zoom: 1, peekGap: 8 }, "darwin");
        applyWindowButtons(win, { visible: true, zoom: 1 }, "darwin");
        expect(win.setWindowButtonPosition.mock.calls.map(([p]) => p)).toEqual([
            macButtonsPosition(1, 8),
            macButtonsPosition(1, 8),
            macButtonsPosition(1),
            macButtonsPosition(1),
        ]);
        expect(macButtonsPosition(1, 8)).toEqual({ x: 20, y: 20 });
    });

    it("places them again once shown, since showing hidden buttons puts them back at the system's spot (#1301)", () => {
        const win = makeWindow();
        const calls: string[] = [];
        win.setWindowButtonVisibility.mockImplementation(() => calls.push("visibility"));
        win.setWindowButtonPosition.mockImplementation(() => calls.push("position"));
        applyWindowButtons(win, { visible: true, zoom: 1, peekGap: 8 }, "darwin");
        expect(calls).toEqual(["position", "visibility", "position"]);
        expect(win.setWindowButtonPosition.mock.calls.at(-1)).toEqual([{ x: 20, y: 20 }]);
    });

    it("sizes the stand-ins like the system's discs, measured on screen (#1301)", () => {
        expect(macButtonDiscs(true)).toEqual({ sizePx: 14, pitchPx: 23 });
        expect(macButtonDiscs(false)).toEqual({ sizePx: 12, pitchPx: 20 });
    });

    it("only shows them for a value that is exactly true", () => {
        const win = makeWindow();
        applyWindowButtons(win, { visible: "yes", zoom: 1 }, "darwin");
        expect(win.setWindowButtonVisibility).toHaveBeenCalledWith(false);
    });

    it("gives the window its own buttons back when the sidebar goes", () => {
        const win = makeWindow();
        applyWindowButtons(win, null, "darwin");
        expect(win.setWindowButtonPosition).toHaveBeenCalledWith(null);
        expect(win.setWindowButtonVisibility).toHaveBeenCalledWith(true);
    });

    it("sizes the controls drawn over the page to the row elsewhere, and leaves their visibility alone", () => {
        for (const platform of ["win32", "linux"]) {
            const win = makeWindow();
            expect(applyWindowButtons(win, { visible: false, zoom: 1 }, platform)).toBe(true);
            applyWindowButtons(win, null, platform);
            expect(win.setTitleBarOverlay.mock.calls).toEqual([
                [{ height: controlsOverlayHeight(1) }],
                [{ height: DefaultControlsOverlayPx }],
            ]);
            expect(win.setWindowButtonVisibility).not.toHaveBeenCalled();
        }
    });

    it("leaves a window without an overlay alone", () => {
        const win = makeWindow();
        win.setTitleBarOverlay.mockImplementation(() => {
            throw new Error("Titlebar overlay is not enabled");
        });
        expect(applyWindowButtons(win, { visible: true, zoom: 1 }, "linux")).toBe(false);
    });

    it("ignores a missing or closed window, and other platforms", () => {
        expect(applyWindowButtons(null, { visible: false, zoom: 1 }, "darwin")).toBe(false);
        const win = makeWindow(true);
        expect(applyWindowButtons(win, { visible: false, zoom: 1 }, "darwin")).toBe(false);
        expect(win.setWindowButtonVisibility).not.toHaveBeenCalled();
        expect(applyWindowButtons(makeWindow(), { visible: false, zoom: 1 }, "freebsd")).toBe(false);
    });
});
