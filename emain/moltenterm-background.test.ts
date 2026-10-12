// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, BaseWindow: class {}, BrowserWindow: class {}, screen: {} }));

import { backgroundPlacement, BackgroundVisiblePx, isBackgroundMode, VirtualFocus } from "./moltenterm-background";

type FakeWin = { name: string; destroyed: boolean; events: string[]; isDestroyed(): boolean; emit(e: string): boolean };

function makeWin(name: string): FakeWin {
    const win: FakeWin = {
        name,
        destroyed: false,
        events: [],
        isDestroyed: () => win.destroyed,
        emit: (e: string) => {
            win.events.push(e);
            return true;
        },
    };
    return win;
}

describe("isBackgroundMode", () => {
    it("is on only with the variable set to 1", () => {
        expect(isBackgroundMode({ MOLTENTERM_BACKGROUND: "1" })).toBe(true);
        expect(isBackgroundMode({})).toBe(false);
        expect(isBackgroundMode({ MOLTENTERM_BACKGROUND: "0" })).toBe(false);
        expect(isBackgroundMode({ MOLTENTERM_BACKGROUND: "" })).toBe(false);
        expect(isBackgroundMode({ MOLTENTERM_BACKGROUND: "true" })).toBe(false);
    });
});

describe("backgroundPlacement", () => {
    const workArea = { x: 0, y: 25, width: 1728, height: 1050 };

    it("keeps the size and leaves only the corner on screen", () => {
        const placed = backgroundPlacement(workArea, { x: 100, y: 100, width: 1200, height: 800 });
        expect(placed).toEqual({
            x: 1728 - BackgroundVisiblePx.width,
            y: 25 + 1050 - BackgroundVisiblePx.height,
            width: 1200,
            height: 800,
        });
    });

    it("follows a work area that does not start at the origin", () => {
        const placed = backgroundPlacement(
            { x: -1920, y: 0, width: 1920, height: 1080 },
            { x: 0, y: 0, width: 900, height: 600 }
        );
        expect(placed.x).toBe(-BackgroundVisiblePx.width);
        expect(placed.y).toBe(1080 - BackgroundVisiblePx.height);
    });

    it("keeps a window smaller than the corner whole on screen", () => {
        const placed = backgroundPlacement(workArea, { x: 0, y: 0, width: 100, height: 80 });
        expect(placed).toEqual({ x: 1728 - 100, y: 25 + 1050 - 80, width: 100, height: 80 });
    });
});

describe("VirtualFocus", () => {
    it("moves the focus as the OS would, with focus and blur events", () => {
        const vf = new VirtualFocus<FakeWin>();
        const a = makeWin("a");
        const b = makeWin("b");
        vf.focus(a);
        expect(vf.is(a)).toBe(true);
        expect(a.events).toEqual(["focus"]);
        vf.focus(a);
        expect(a.events).toEqual(["focus"]);
        vf.focus(b);
        expect(vf.is(a)).toBe(false);
        expect(vf.is(b)).toBe(true);
        expect(a.events).toEqual(["focus", "blur"]);
        expect(b.events).toEqual(["focus"]);
    });

    it("blurs only the focused window", () => {
        const vf = new VirtualFocus<FakeWin>();
        const a = makeWin("a");
        const b = makeWin("b");
        vf.focus(a);
        vf.blur(b);
        expect(vf.get()).toBe(a);
        vf.blur(a);
        expect(vf.get()).toBe(null);
        expect(a.events).toEqual(["focus", "blur"]);
    });

    it("drops a destroyed window without emitting on it", () => {
        const vf = new VirtualFocus<FakeWin>();
        const a = makeWin("a");
        const b = makeWin("b");
        vf.focus(a);
        a.destroyed = true;
        expect(vf.get()).toBe(null);
        vf.focus(b);
        expect(a.events).toEqual(["focus"]);
        vf.focus(a);
        expect(vf.get()).toBe(b);
    });

    it("forgets a closed window", () => {
        const vf = new VirtualFocus<FakeWin>();
        const a = makeWin("a");
        vf.focus(a);
        vf.forget(a);
        expect(vf.get()).toBe(null);
        expect(a.events).toEqual(["focus"]);
    });
});
