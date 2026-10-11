// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { readFileSync } from "fs";
import { atom, createStore, PrimitiveAtom } from "jotai";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followActivityGated, makeOnScreenAtom, TabActivity, whileShown } from "./tab-activity";
import { WindowActivity } from "./tab-activity-model";

type FakeApi = {
    window: WindowActivity;
    push: (activity: WindowActivity) => void;
};

function installApi(initial: WindowActivity): FakeApi {
    const fake: FakeApi = { window: initial, push: null };
    (globalThis as any).api = {
        moltentermGetWindowActivity: () => fake.window,
        onMoltentermWindowActivity: (cb: (a: WindowActivity) => void) => {
            fake.push = (a) => {
                fake.window = a;
                cb(a);
            };
        },
    };
    return fake;
}

const Focused: WindowActivity = { focused: true, minimized: false, shown: true };
const Unfocused: WindowActivity = { focused: false, minimized: false, shown: true };
const Minimized: WindowActivity = { focused: false, minimized: true, shown: true };

describe("which view is on screen", () => {
    function setup() {
        const store = createStore();
        const windowWs = atom("ws-a") as PrimitiveAtom<string>;
        const viewWs = atom("ws-a") as PrimitiveAtom<string>;
        const ws = atom({ oid: "ws-a", activetabid: "tab-1" } as Workspace) as PrimitiveAtom<Workspace>;
        const tab = atom("tab-1") as PrimitiveAtom<string>;
        return { store, windowWs, ws, tab, onScreen: makeOnScreenAtom(windowWs, viewWs, ws, tab) };
    }

    it("is the view of the window's workspace whose tab is the active one", () => {
        const { store, onScreen } = setup();
        expect(store.get(onScreen)).toBe(true);
    });

    it("is not a view of another workspace (kept off-screen since #68)", () => {
        const { store, windowWs, onScreen } = setup();
        store.set(windowWs, "ws-b");
        expect(store.get(onScreen)).toBe(false);
    });

    it("is not a view of another tab of the same workspace", () => {
        const { store, ws, onScreen } = setup();
        store.set(ws, { oid: "ws-a", activetabid: "tab-2" } as Workspace);
        expect(store.get(onScreen)).toBe(false);
    });

    it("counts as on screen while the data is missing", () => {
        const { store, windowWs, ws, onScreen } = setup();
        store.set(windowWs, null);
        store.set(ws, null);
        expect(store.get(onScreen)).toBe(true);
    });
});

describe("TabActivity", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        TabActivity.resetInstance();
    });
    afterEach(() => {
        vi.useRealTimers();
        delete (globalThis as any).api;
        TabActivity.resetInstance();
    });

    it("follows the window state pushed by the main process", () => {
        const api = installApi(Focused);
        const activity = TabActivity.getInstance();
        activity.start();
        expect(activity.state()).toBe("active");
        api.push(Unfocused);
        expect(activity.state()).toBe("visible");
        api.push(Minimized);
        expect(activity.state()).toBe("minimized");
        expect(activity.scheduler.state).toBe("minimized");
    });

    it("fires no pane-status, mission or bell job while minimised, then refreshes at once (AC2, AC5)", () => {
        const api = installApi(Focused);
        const activity = TabActivity.getInstance();
        const runs: string[] = [];
        for (const label of ["pane-status", "mission", "bell-work"]) {
            activity.every(whileShown(3000), (reason) => runs.push(`${label}:${reason}`), label);
        }
        api.push(Minimized);
        expect(activity.scheduler.armedLabels()).toEqual([]);
        vi.advanceTimersByTime(60000);
        expect(runs).toEqual([]);
        api.push(Unfocused);
        expect(runs).toEqual(["pane-status:resume", "mission:resume", "bell-work:resume"]);
    });

    it("reads the window again for a reused view", () => {
        const api = installApi(Focused);
        const activity = TabActivity.getInstance();
        activity.start();
        api.window = Unfocused;
        activity.refreshWindow();
        expect(activity.state()).toBe("visible");
    });

    it("works without the main process (preview server)", () => {
        const activity = TabActivity.getInstance();
        activity.start();
        expect(activity.state()).toBe("active");
    });
});

describe("gated values (sysinfo chart, AC3)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        TabActivity.resetInstance();
    });
    afterEach(() => {
        vi.useRealTimers();
        delete (globalThis as any).api;
        TabActivity.resetInstance();
    });

    function setup(live: boolean, initial: WindowActivity = Focused) {
        const api = installApi(initial);
        const activity = TabActivity.getInstance();
        const source = atom(0) as PrimitiveAtom<number>;
        const seen: number[] = [];
        const stop = followActivityGated(activity, source, live, 5000, (v) => seen.push(v));
        // one sample a second, like the sysinfo events
        const tick = (n: number) => {
            for (let i = 0; i < n; i++) {
                globalStore.set(source, globalStore.get(source) + 1);
                vi.advanceTimersByTime(1000);
            }
        };
        return { api, seen, stop, tick };
    }

    it("follows every sample while the window and the panel are focused", () => {
        const { seen, tick } = setup(true);
        tick(5);
        expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("samples at most every 5 s while the panel is not focused", () => {
        const { seen, tick } = setup(false);
        tick(20);
        expect(seen).toEqual([5, 10, 15, 20]);
    });

    it("samples at most every 5 s while the window is not focused", () => {
        const { seen, tick } = setup(true, Unfocused);
        tick(10);
        expect(seen).toEqual([5, 10]);
    });

    it("does not redraw while minimised, and catches up at once on return", () => {
        const { api, seen, tick } = setup(true);
        api.push(Minimized);
        const before = seen.length;
        tick(30);
        expect(seen.length).toBe(before);
        api.push(Focused);
        expect(seen[seen.length - 1]).toBe(30);
    });

    it("stops when disposed", () => {
        const { seen, stop, tick } = setup(false);
        stop();
        tick(20);
        expect(seen).toEqual([]);
    });
});

describe("working animations stand still when the view is not active (AC4)", () => {
    const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");

    it("covers the tab dot, the header segment, the heat glow, the rail dot and the bell", () => {
        expect(read("tab-bar.css")).toContain(
            ':root[data-mt-motion="still"] .molten-tab-dot[data-state="working"]::after'
        );
        expect(read("header/header.css")).toContain(':root[data-mt-motion="still"] .molten-header-working::before');
        const shell = read("moltenterm-shell.css");
        expect(shell).toContain(':root[data-mt-motion="still"] .block.block-frame-default[data-mt-agent-state]::after');
        expect(shell).toContain(':root[data-mt-motion="still"] .mt-working-motion');
        expect(shell).toContain(".prefers-reduced-motion .mt-working-motion");
        expect(read("agent-state-ui.tsx")).toContain('"mt-working-motion animate-pulse"');
        expect(read("notification-center.tsx")).toContain('"mt-working-motion animate-spin"');
    });
});
