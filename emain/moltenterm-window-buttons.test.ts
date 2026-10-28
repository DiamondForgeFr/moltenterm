// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("./emain-window", () => ({ getWaveWindowByWebContentsId: () => null }));
vi.mock("./moltenterm-privileged-ipc", () => ({ onAppIpc: () => {} }));

import { applyWindowButtons } from "./moltenterm-window-buttons";

function makeWindow(destroyed = false) {
    return { isDestroyed: () => destroyed, setWindowButtonVisibility: vi.fn() };
}

describe("the window buttons follow the hidden sidebar (DS-SHELL-127)", () => {
    it("hides and shows them on macOS", () => {
        const win = makeWindow();
        expect(applyWindowButtons(win, false, "darwin")).toBe(true);
        expect(applyWindowButtons(win, true, "darwin")).toBe(true);
        expect(win.setWindowButtonVisibility.mock.calls).toEqual([[false], [true]]);
    });

    it("only shows them for a value that is exactly true", () => {
        const win = makeWindow();
        applyWindowButtons(win, "yes", "darwin");
        expect(win.setWindowButtonVisibility).toHaveBeenCalledWith(false);
    });

    it("leaves other platforms' window controls alone", () => {
        const win = makeWindow();
        expect(applyWindowButtons(win, false, "win32")).toBe(false);
        expect(applyWindowButtons(win, false, "linux")).toBe(false);
        expect(win.setWindowButtonVisibility).not.toHaveBeenCalled();
    });

    it("ignores a missing or closed window", () => {
        expect(applyWindowButtons(null, false, "darwin")).toBe(false);
        const win = makeWindow(true);
        expect(applyWindowButtons(win, false, "darwin")).toBe(false);
        expect(win.setWindowButtonVisibility).not.toHaveBeenCalled();
    });
});
