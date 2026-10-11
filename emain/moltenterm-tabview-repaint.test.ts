// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The paint check of a reused tab view (#223) cannot misfire on a window that cannot show frames (#461).

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    checkReusedTabViewPainted,
    DeferredPaintCheckRetryMs,
    windowCanShowFrames,
} from "./moltenterm-tabview-repaint";

const env = vi.hoisted(() => ({ idleSec: 0, hostEnabled: true, destroyed: [] as string[] }));

vi.mock("electron", () => ({ powerMonitor: { getSystemIdleTime: () => env.idleSec } }));
vi.mock("./moltenterm-tabview-host", () => ({
    isTabViewHostEnabled: () => env.hostEnabled,
    destroyTabView: (view: any, reason: string) => {
        env.destroyed.push(`${view.waveTabId}: ${reason}`);
        view.isDestroyed = true;
    },
}));

const Rendering = { visible: true, frames: 2 };
const NoFrames = { visible: false, frames: 0 };

function makeView(tabId = "tab-a") {
    const view: any = {
        waveTabId: tabId,
        isDestroyed: false,
        probe: NoFrames as { visible: boolean; frames: number },
        cycles: 0,
        webContents: { executeJavaScript: vi.fn(async () => view.probe) },
        setVisible: vi.fn((visible: boolean) => {
            if (!visible) {
                view.cycles++;
            }
        }),
    };
    return view;
}

function makeWindow(view: any, opts: { focused?: boolean; minimized?: boolean; visible?: boolean } = {}) {
    const win: any = new EventEmitter();
    win.activeTabView = view;
    win.focused = opts.focused ?? true;
    win.minimized = opts.minimized ?? false;
    win.visible = opts.visible ?? true;
    win.isDestroyed = () => false;
    win.actionQueue = { length: 0 };
    win.isFocused = () => win.focused;
    win.isMinimized = () => win.minimized;
    win.isVisible = () => win.visible;
    win.setActiveTab = vi.fn(async () => {});
    return win;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    env.idleSec = 0;
    env.hostEnabled = true;
    env.destroyed = [];
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("windowCanShowFrames", () => {
    it("needs a visible, unminimised, focused window and a user who used the machine recently", () => {
        const win = makeWindow(makeView());
        expect(windowCanShowFrames(win, 0)).toBe(true);
        expect(windowCanShowFrames(win, 120)).toBe(false);
        win.focused = false;
        expect(windowCanShowFrames(win, 0)).toBe(false);
        win.focused = true;
        win.minimized = true;
        expect(windowCanShowFrames(win, 0)).toBe(false);
        win.minimized = false;
        win.visible = false;
        expect(windowCanShowFrames(win, 0)).toBe(false);
        win.visible = true;
        win.actionQueue = { length: 1 };
        expect(windowCanShowFrames(win, 0)).toBe(false);
    });
});

describe("checkReusedTabViewPainted (#223, #461)", () => {
    it("rebuilds a view with no frames in a focused window in use, as before", async () => {
        const view = makeView();
        const win = makeWindow(view);
        checkReusedTabViewPainted(win, view);
        await vi.advanceTimersByTimeAsync(2000);
        expect(view.cycles).toBe(1);
        expect(env.destroyed).toEqual(["tab-a: paint check: it does not render (#223)"]);
        expect(win.setActiveTab).toHaveBeenCalledWith("tab-a", false);
    });

    it("defers on an unfocused window, then judges once the window gets the focus", async () => {
        const view = makeView();
        const win = makeWindow(view, { focused: false });
        checkReusedTabViewPainted(win, view);
        await vi.advanceTimersByTimeAsync(5000);
        expect(view.cycles).toBe(0);
        expect(env.destroyed).toEqual([]);
        win.focused = true;
        win.emit("focus");
        await vi.advanceTimersByTimeAsync(2000);
        expect(view.cycles).toBe(1);
        expect(env.destroyed).toHaveLength(1);
    });

    it("never touches a working view once its window shows it again", async () => {
        const view = makeView();
        const win = makeWindow(view, { minimized: true });
        checkReusedTabViewPainted(win, view);
        await vi.advanceTimersByTimeAsync(2000);
        win.minimized = false;
        view.probe = Rendering;
        win.emit("focus");
        await vi.advanceTimersByTimeAsync(2000);
        expect(view.cycles).toBe(0);
        expect(env.destroyed).toEqual([]);
        expect(view.webContents.executeJavaScript).toHaveBeenCalledTimes(2);
    });

    it("defers while the user is away (display asleep with the window focused), and looks again periodically", async () => {
        const view = makeView();
        const win = makeWindow(view);
        env.idleSec = 300;
        checkReusedTabViewPainted(win, view);
        await vi.advanceTimersByTimeAsync(3 * DeferredPaintCheckRetryMs);
        expect(env.destroyed).toEqual([]);
        expect(view.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
        env.idleSec = 1;
        view.probe = Rendering;
        await vi.advanceTimersByTimeAsync(DeferredPaintCheckRetryMs + 1000);
        expect(view.webContents.executeJavaScript).toHaveBeenCalledTimes(2);
        expect(env.destroyed).toEqual([]);
    });

    it("drops a deferred check once the view is no longer the one shown", async () => {
        const view = makeView();
        const win = makeWindow(view, { focused: false });
        checkReusedTabViewPainted(win, view);
        await vi.advanceTimersByTimeAsync(2000);
        win.activeTabView = makeView("tab-b");
        win.focused = true;
        win.emit("focus");
        await vi.advanceTimersByTimeAsync(3 * DeferredPaintCheckRetryMs);
        expect(view.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
        expect(env.destroyed).toEqual([]);
        expect(win.listenerCount("focus")).toBe(0);
    });

    it("does not defer a view that renders, whatever its window", async () => {
        const view = makeView();
        view.probe = Rendering;
        const win = makeWindow(view, { focused: false });
        checkReusedTabViewPainted(win, view);
        await vi.advanceTimersByTimeAsync(2000);
        expect(win.listenerCount("focus")).toBe(0);
        expect(view.cycles).toBe(0);
    });

    it("judges at once with moltenterm:tabviewhost false (previous behaviour)", async () => {
        env.hostEnabled = false;
        const view = makeView();
        const win = makeWindow(view, { focused: false });
        checkReusedTabViewPainted(win, view);
        await vi.advanceTimersByTimeAsync(2000);
        expect(view.cycles).toBe(1);
        expect(env.destroyed).toHaveLength(1);
    });

    it("keeps one deferred check per view when the view is shown again meanwhile", async () => {
        const view = makeView();
        const win = makeWindow(view, { focused: false });
        checkReusedTabViewPainted(win, view);
        await vi.advanceTimersByTimeAsync(2000);
        checkReusedTabViewPainted(win, view);
        await vi.advanceTimersByTimeAsync(2000);
        expect(win.listenerCount("focus")).toBe(1);
        win.focused = true;
        view.probe = Rendering;
        win.emit("focus");
        await vi.advanceTimersByTimeAsync(2000);
        expect(view.webContents.executeJavaScript).toHaveBeenCalledTimes(3);
        expect(win.listenerCount("focus")).toBe(0);
        await vi.advanceTimersByTimeAsync(3 * DeferredPaintCheckRetryMs);
        expect(view.webContents.executeJavaScript).toHaveBeenCalledTimes(3);
    });
});
