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

// --- a small fake page: the sidebar's viewport, its rows' page (content) and the neighbours' ghosts beside it

type Record_ = { type: string; target: FakeEl; addedNodes: FakeEl[]; removedNodes: FakeEl[] };
const observers = new Set<FakeObserver>();

class FakeObserver {
    target: FakeEl = null;
    constructor(readonly cb: (records: Record_[]) => void) {
        observers.add(this);
    }
    observe(target: FakeEl) {
        this.target = target;
    }
    disconnect() {
        observers.delete(this);
    }
}

function notify(record: Record_) {
    for (const o of Array.from(observers)) {
        if (o.target != null && o.target.contains(record.target)) {
            o.cb([record]);
        }
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
    scrollTop = 0;
    scrollLeft = 0;
    offsetTop = 0;
    offsetLeft = 0;
    get classList() {
        return { contains: (c: string) => this.className.split(/\s+/).includes(c) };
    }
    getBoundingClientRect() {
        return Box;
    }
    contains(other: FakeEl): boolean {
        for (let e = other; e != null; e = e.parent) {
            if (e === this) return true;
        }
        return false;
    }
    appendChild(c: FakeEl) {
        c.parent = this;
        this.children.push(c);
        notify({ type: "childList", target: this, addedNodes: [c], removedNodes: [] });
        return c;
    }
    remove() {
        const p = this.parent;
        if (p != null) {
            p.children = p.children.filter((c) => c !== this);
            this.parent = null;
            notify({ type: "childList", target: p, addedNodes: [], removedNodes: [this] });
        }
    }
    // A change of this element's own text or attributes.
    touch() {
        notify({ type: "attributes", target: this, addedNodes: [], removedNodes: [] });
    }
    querySelector(sel: string): FakeEl {
        const cls = sel.replace(/^\./, "");
        for (const c of this.children) {
            if (c.classList.contains(cls)) return c;
            const d = c.querySelector(sel);
            if (d != null) return d;
        }
        return null;
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
let content: FakeEl;
let row: FakeEl;
let ghost: FakeEl;
let atRest = true;
let stop: () => void = null;
let doc: any;

function setVisibility(v: "visible" | "hidden") {
    doc.visibilityState = v;
    for (const fn of Array.from(doc.listeners as Set<() => void>)) {
        fn();
    }
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    api.shots = [];
    api.rows = 2;
    atRest = true;
    observers.clear();
    resetSidebarClocks();
    viewport = new FakeEl();
    content = viewport.appendChild(new FakeEl());
    content.className = "mt-sb-page";
    row = content.appendChild(new FakeEl());
    ghost = viewport.appendChild(new FakeEl());
    ghost.className = "mt-sb-ghost";
    const listeners = new Set<() => void>();
    doc = {
        visibilityState: "hidden",
        listeners,
        documentElement: { classList: { contains: () => false } },
        createElement: () => new FakeEl(),
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
    vi.stubGlobal("document", doc);
    const noop = () => {};
    vi.stubGlobal("window", { localStorage: fakeStorage(), addEventListener: noop, removeEventListener: noop });
    vi.stubGlobal("getComputedStyle", (el: FakeEl) => ({
        getPropertyValue: () => "",
        position: el?.style?.position || "static",
    }));
    vi.stubGlobal("MutationObserver", FakeObserver);
});

afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

function start() {
    stop = startSidebarCapture(Ws, {
        viewport: () => viewport as any,
        rows: () => content as any,
        atRest: () => atRest,
    });
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
        content.appendChild(new FakeEl());
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
            row.touch();
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

    it("ignores a neighbour's new capture in its ghost: no capture loop between hidden views", async () => {
        start();
        await vi.advanceTimersByTimeAsync(SnapshotSettleMs);
        expect(api.shots).toHaveLength(1);
        for (let i = 0; i < 5; i++) {
            ghost.touch();
            ghost.appendChild(new FakeEl());
            await vi.advanceTimersByTimeAsync(SnapshotMinGapMs + SnapshotSettleMs);
        }
        expect(api.shots).toHaveLength(1);
        expect(sidebarCaptureCurrent(Ws, 256, 900)).toBe(true);
    });

    it("counts a restart of the capture (a reinit in the same page) as freshly drawn rows", async () => {
        start();
        await vi.advanceTimersByTimeAsync(SnapshotSettleMs);
        expect(sidebarCaptureCurrent(Ws, 256, 900)).toBe(true);
        stop();
        vi.advanceTimersByTime(10);
        start();
        expect(sidebarCaptureCurrent(Ws, 256, 900)).toBe(false);
    });
});

describe("a switch landing on the side panel (#2438)", () => {
    it("changes nothing when the capture it slid in is current", async () => {
        start();
        await vi.advanceTimersByTimeAsync(SnapshotSettleMs);
        expect(landSidebar(viewport as any, content as any, Ws)).toBe("current");
        expect(content.children).toEqual([row]);
        expect(content.animations).toHaveLength(0);
    });

    it("cross-fades from a capture older than the rows, inside the rows' page so it moves with the slide", async () => {
        start();
        await vi.advanceTimersByTimeAsync(SnapshotSettleMs + 10);
        // A row changed after the last capture, and the switch lands before the next one ran.
        api.rows = 3;
        row.touch();
        content.scrollTop = 40;
        content.offsetTop = 6;
        expect(landSidebar(viewport as any, content as any, Ws)).toBe("picture");
        const img = content.querySelector("." + LandingPictureClass);
        expect(img.parent).toBe(content);
        expect(viewport.children.includes(img)).toBe(false);
        expect([img.style.top, img.style.left, img.style.width]).toEqual(["34px", "0px", "256px"]);
        expect(content.style.position).toBe("relative");
        expect(img.src).toBe("data:image/png;base64,rows2");
        expect(img.style.pointerEvents).toBe("none");
        expect(img.animations[0].frames).toEqual([{ opacity: 1 }, { opacity: 0 }]);
        img.animations[0].onfinish();
        expect(content.querySelector("." + LandingPictureClass)).toBeNull();
        expect(content.style.position || "").toBe("");
    });

    it("never counts its own picture as a change of the rows", async () => {
        start();
        await vi.advanceTimersByTimeAsync(SnapshotSettleMs + 10);
        row.touch();
        landSidebar(viewport as any, content as any, Ws);
        await vi.advanceTimersByTimeAsync(SnapshotMinGapMs + SnapshotSettleMs);
        // The picture is still on (its fade never ended): no capture of it.
        expect(api.shots).toHaveLength(1);
        content.querySelector("." + LandingPictureClass).animations[0].onfinish();
        await vi.advanceTimersByTimeAsync(SnapshotSettleMs);
        expect(api.shots).toHaveLength(2);
        expect(sidebarCaptureCurrent(Ws, 256, 900)).toBe(true);
    });

    it("drops the picture when the view leaves the screen in the middle of its fade", async () => {
        start();
        await vi.advanceTimersByTimeAsync(SnapshotSettleMs + 10);
        row.touch();
        setVisibility("visible");
        landSidebar(viewport as any, content as any, Ws);
        expect(content.querySelector("." + LandingPictureClass)).not.toBeNull();
        setVisibility("hidden");
        expect(content.querySelector("." + LandingPictureClass)).toBeNull();
        expect(content.style.position || "").toBe("");
    });

    it("fades the real side panel in when no capture fits, never showing a loader", () => {
        window.localStorage.setItem(
            snapshotKey(Ws),
            JSON.stringify({ url: "data:image/png;base64,old", width: 300, height: 900, at: 1 })
        );
        expect(landSidebar(viewport as any, content as any, Ws)).toBe("fade");
        expect(content.animations[0].frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
        expect(content.children).toEqual([row]);
    });
});
