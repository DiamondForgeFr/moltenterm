// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A hidden workspace's side panel capture stays current (#2438, FR-SHELL-082): its view keeps capturing after each
// change of its rows while it is hidden, at the same throttle, and a switch that lands on a capture still behind brings
// the real side panel in by a short fade instead of a row popping in. On the real module, a fake page and a fake clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ shots: [] as { x: number; y: number; width: number; height: number }[], rows: 2 }));

vi.mock("@/app/store/global", () => ({
    getApi: () => ({
        captureScreenshot: async (rect: { x: number; y: number; width: number; height: number }) => {
            api.shots.push(rect);
            return `data:image/png;base64,rows${api.rows}`;
        },
    }),
}));
vi.mock("./sidebar-material", () => ({ withoutMaterial: async (url: string) => url }));

import {
    landSidebar,
    LandingPictureClass,
    readSnapshot,
    resetSidebarClocks,
    sidebarCaptureCurrent,
    SnapshotMinGapMs,
    SnapshotSettleMs,
    snapshotKey,
    startSidebarCapture,
} from "./sidebar-snapshot";

const Ws = "ws-andvari";
const Box = { left: 8, top: 80, width: 256, height: 900 };

let mutate: () => void = null;

class FakeObserver {
    constructor(cb: () => void) {
        mutate = cb;
    }
    observe() {}
    disconnect() {
        mutate = null;
    }
}

class FakeEl {
    className = "";
    style: Record<string, string> = {};
    children: FakeEl[] = [];
    parent: FakeEl = null;
    animations: { frames: any[]; onfinish?: () => void; oncancel?: () => void }[] = [];
    attrs: Record<string, string> = {};
    src = "";
    alt = "";
    draggable = true;
    getBoundingClientRect() {
        return Box;
    }
    appendChild(c: FakeEl) {
        c.parent = this;
        this.children.push(c);
        mutate?.();
        return c;
    }
    remove() {
        if (this.parent != null) {
            this.parent.children = this.parent.children.filter((c) => c !== this);
            this.parent = null;
        }
    }
    setAttribute(k: string, v: string) {
        this.attrs[k] = v;
    }
    animate(frames: any[]) {
        const a = { frames };
        this.animations.push(a);
        return a;
    }
}

function fakeStorage() {
    const m = new Map<string, string>();
    return {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, v),
        removeItem: (k: string) => void m.delete(k),
    };
}

let viewport: FakeEl;
let atRest = true;
let stop: () => void = null;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    api.shots = [];
    api.rows = 2;
    atRest = true;
    resetSidebarClocks();
    viewport = new FakeEl();
    const noop = () => {};
    vi.stubGlobal("document", {
        visibilityState: "hidden",
        documentElement: { classList: { contains: () => false } },
        createElement: () => new FakeEl(),
        addEventListener: noop,
        removeEventListener: noop,
    });
    vi.stubGlobal("window", { localStorage: fakeStorage(), addEventListener: noop, removeEventListener: noop });
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    vi.stubGlobal("MutationObserver", FakeObserver);
});

afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function start() {
    stop = startSidebarCapture(Ws, { viewport: () => viewport as any, atRest: () => atRest });
}

describe("a hidden workspace's side panel capture (#2438)", () => {
    it("is taken while the view is hidden, once its rows settled", async () => {
        start();
        await vi.advanceTimersByTimeAsync(SnapshotSettleMs - 1);
        expect(api.shots).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(api.shots).toEqual([{ x: 8, y: 80, width: 256, height: 900 }]);
        expect(readSnapshot(Ws)?.url).toBe("data:image/png;base64,rows2");
        expect(sidebarCaptureCurrent(Ws, 256, 900)).toBe(true);
    });

    it("is refreshed when its rows change while it is hidden, within the throttle", async () => {
        start();
        await vi.advanceTimersByTimeAsync(SnapshotSettleMs);
        expect(api.shots).toHaveLength(1);
        // An agent starts in the hidden workspace: a row is added.
        await vi.advanceTimersByTimeAsync(1000);
        api.rows = 3;
        mutate();
        const changedAt = Date.now();
        expect(sidebarCaptureCurrent(Ws, 256, 900)).toBe(false);
        await vi.advanceTimersByTimeAsync(SnapshotMinGapMs + SnapshotSettleMs);
        expect(api.shots).toHaveLength(2);
        const snap = readSnapshot(Ws);
        expect(snap.url).toBe("data:image/png;base64,rows3");
        expect(snap.at - changedAt).toBeLessThanOrEqual(SnapshotMinGapMs + SnapshotSettleMs);
        expect(sidebarCaptureCurrent(Ws, 256, 900)).toBe(true);
    });

    it("never takes more than one capture per throttle, however often the rows change", async () => {
        start();
        for (let i = 0; i < 40; i++) {
            mutate();
            await vi.advanceTimersByTimeAsync(250);
        }
        await vi.advanceTimersByTimeAsync(SnapshotMinGapMs + SnapshotSettleMs);
        expect(api.shots.length).toBeLessThanOrEqual(Math.ceil((40 * 250) / SnapshotMinGapMs) + 1);
        expect(sidebarCaptureCurrent(Ws, 256, 900)).toBe(true);
    });

    it("is not taken while something covers the sidebar, and stays behind until it is", async () => {
        atRest = false;
        start();
        await vi.advanceTimersByTimeAsync(SnapshotMinGapMs);
        expect(api.shots).toHaveLength(0);
        expect(sidebarCaptureCurrent(Ws, 256, 900)).toBe(false);
        atRest = true;
        await vi.advanceTimersByTimeAsync(SnapshotSettleMs);
        expect(api.shots).toHaveLength(1);
    });
});

describe("a switch landing on the side panel (#2438)", () => {
    it("changes nothing when the capture it slid in is current", async () => {
        start();
        await vi.advanceTimersByTimeAsync(SnapshotSettleMs);
        expect(landSidebar(viewport as any, Ws)).toBe("current");
        expect(viewport.children).toHaveLength(0);
        expect(viewport.animations).toHaveLength(0);
    });

    it("cross-fades from a capture older than the rows, so no row pops in", async () => {
        start();
        await vi.advanceTimersByTimeAsync(SnapshotSettleMs + 10);
        // A row changed after the last capture, and the switch lands before the next one ran.
        api.rows = 3;
        mutate();
        expect(landSidebar(viewport as any, Ws)).toBe("picture");
        const [img] = viewport.children;
        expect(img.className).toBe(LandingPictureClass);
        expect(img.src).toBe("data:image/png;base64,rows2");
        expect(img.style.pointerEvents).toBe("none");
        expect(img.animations[0].frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
        img.animations[0].onfinish();
        expect(viewport.children).toHaveLength(0);
    });

    it("fades the real side panel in when no capture fits, never showing a loader", () => {
        window.localStorage.setItem(
            snapshotKey(Ws),
            JSON.stringify({ url: "data:image/png;base64,old", width: 300, height: 900, at: 1 })
        );
        expect(landSidebar(viewport as any, Ws)).toBe("fade");
        expect(viewport.animations[0].frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
        expect(viewport.children).toHaveLength(0);
    });
});
