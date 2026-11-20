// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The lifetimes of the switch's layers (#2407), on the real module over a small fake page and a fake clock: neither
// layer outlives its switch, and the content always gets its own opacity back (the class of bug #2398 fixed for the
// switch picture).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wos = vi.hoisted(() => ({ activeTab: new Map<string, string>() }));

vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    getObjectValue: (oref: string) => {
        const [otype, oid] = oref.split(":");
        return otype === "workspace" && wos.activeTab.has(oid) ? { oid, activetabid: wos.activeTab.get(oid) } : null;
    },
}));
vi.mock("./layout-store", () => ({ loadLayout: (): null => null }));

import {
    ArrivalLayerId,
    ArrivalMaxMs,
    ArrivalOnScreenFallbackMs,
    ArrivalPanelMaxMs,
    arrivedOnScreen,
    arriving,
    clearArrival,
    clearLeave,
    holdLeave,
    LeaveLayerId,
    leaveProgress,
    LeaveMaxMs,
    leaving,
    playLeave,
    prepareLeave,
    resetSwitchLayoutFlag,
    switchRefused,
    wearArrival,
} from "./layout-frames";
import { RememberedLayout } from "./layout-memory";

// --- a small fake page: elements, their boxes and their Web Animations

type Listener = (e: any) => void;

class FakeEvents {
    listeners = new Map<string, Set<Listener>>();
    addEventListener(type: string, fn: Listener) {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, new Set());
        }
        this.listeners.get(type).add(fn);
    }
    removeEventListener(type: string, fn: Listener) {
        this.listeners.get(type)?.delete(fn);
    }
    dispatch(type: string, e: any = {}) {
        for (const fn of Array.from(this.listeners.get(type) ?? [])) {
            fn({ type, ...e });
        }
    }
}

class FakeAnimation {
    onfinish: () => void = null;
    oncancel: () => void = null;
    ready = Promise.resolve();
    done = false;
    constructor(
        readonly el: FakeEl,
        duration: number
    ) {
        setTimeout(() => {
            if (!this.done) {
                this.done = true;
                el.animations.delete(this);
                this.onfinish?.();
            }
        }, duration);
    }
    cancel() {
        if (this.done) {
            return;
        }
        this.done = true;
        this.el.animations.delete(this);
        this.oncancel?.();
    }
}

class FakeEl extends FakeEvents {
    id = "";
    className = "";
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    children: FakeEl[] = [];
    parentNode: FakeEl = null;
    attrs = new Map<string, string>();
    animations = new Set<FakeAnimation>();
    rect: { left: number; top: number; width: number; height: number } = null;
    constructor(readonly tagName: string) {
        super();
    }
    setAttribute(k: string, v: string) {
        this.attrs.set(k, v);
    }
    getAttribute(k: string) {
        return this.attrs.get(k) ?? null;
    }
    appendChild(c: FakeEl) {
        c.parentNode = this;
        this.children.push(c);
        return c;
    }
    remove() {
        if (this.parentNode) {
            this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
            this.parentNode = null;
        }
    }
    get isConnected(): boolean {
        return page.root.all().includes(this);
    }
    getBoundingClientRect() {
        if (this.rect) {
            return this.rect;
        }
        const px = (v: string) => parseFloat(v ?? "0") || 0;
        return { left: px(this.style.left), top: px(this.style.top), width: px(this.style.width), height: px(this.style.height) };
    }
    animate(_frames: unknown, opts: { duration: number }) {
        const a = new FakeAnimation(this, opts.duration);
        this.animations.add(a);
        return a;
    }
    getAnimations() {
        return Array.from(this.animations);
    }
    all(): FakeEl[] {
        return this.children.flatMap((c) => [c, ...c.all()]);
    }
    matches(sel: string): boolean {
        if (sel.startsWith("#")) {
            return this.id === sel.slice(1);
        }
        const m = /^((?:\.[\w-]+)*)(?:\[data-([\w-]+)(?:="([^"]*)")?\])?$/.exec(sel);
        if (m == null) {
            return false;
        }
        const classes = (m[1] ?? "").split(".").filter(Boolean);
        const own = this.className.split(/\s+/);
        if (!classes.every((c) => own.includes(c))) {
            return false;
        }
        if (m[2] != null) {
            const key = m[2].replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
            const v = this.dataset[key];
            return m[3] == null ? v != null : v === m[3];
        }
        return true;
    }
    querySelector(sel: string) {
        return this.all().find((e) => e.matches(sel)) ?? null;
    }
    querySelectorAll(sel: string) {
        return this.all().filter((e) => e.matches(sel));
    }
}

type Page = {
    root: FakeEl;
    body: FakeEl;
    document: any;
    window: FakeEvents & { innerWidth: number; innerHeight: number };
};
let page: Page;

function makePage(): Page {
    const root = new FakeEl("html");
    const body = root.appendChild(new FakeEl("body"));
    const docEvents = new FakeEvents();
    const document: any = Object.assign(docEvents, {
        documentElement: root,
        body,
        visibilityState: "hidden",
        createElement: (tag: string) => new FakeEl(tag),
        getElementById: (id: string) => root.all().find((e) => e.id === id) ?? null,
        querySelector: (sel: string) => root.querySelector(sel),
        querySelectorAll: (sel: string) => root.querySelectorAll(sel),
    });
    const win = Object.assign(new FakeEvents(), { innerWidth: 1600, innerHeight: 1000 });
    return { root, body, document, window: win };
}

function setVisibility(v: "visible" | "hidden") {
    page.document.visibilityState = v;
    page.document.dispatch("visibilitychange");
}

// The content area of a 1600 x 1000 window beside a 264 px sidebar, and a block that may be mounted in it.
function addContent(): FakeEl {
    const content = new FakeEl("div");
    content.className = "relative mt-frame-content";
    content.rect = { left: 264, top: 0, width: 1336, height: 1000 };
    page.body.appendChild(content);
    return content;
}

function mountBlock(content: FakeEl, id: string, rect: { left: number; top: number; width: number; height: number }) {
    const block = new FakeEl("div");
    block.className = "block block-frame-default";
    block.dataset.blockid = id;
    block.rect = rect;
    const screen = new FakeEl("div");
    screen.className = "xterm-screen";
    block.appendChild(screen);
    content.appendChild(block);
    return block;
}

const Layout: RememberedLayout = {
    workspaceId: "ws-beta",
    tabId: "tab-beta",
    insets: { left: 264, top: 0, right: 0, bottom: 0 },
    panels: [
        { id: "b1", kind: "term", x: 0, y: 0, w: 0.5, h: 1 },
        { id: "b2", kind: "term", x: 0.5, y: 0, w: 0.5, h: 1 },
    ],
    at: 1,
};

function layer(id: string): FakeEl {
    return page.root.all().find((e) => e.id === id) ?? null;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    page = makePage();
    vi.stubGlobal("document", page.document);
    vi.stubGlobal("window", page.window);
    vi.stubGlobal("getComputedStyle", (el: FakeEl) => ({
        getPropertyValue: () => "",
        opacity: el.style?.opacity ?? "1",
    }));
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => setTimeout(() => fn(Date.now()), 16));
    vi.stubGlobal("cancelAnimationFrame", (id: any) => clearTimeout(id));
    (globalThis as any).api = { getEnv: (): string => null };
    resetSwitchLayoutFlag();
    wos.activeTab.clear();
});

afterEach(() => {
    clearLeave();
    clearArrival();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (globalThis as any).api;
});

describe("the frames over the view being left (#2407)", () => {
    it("draws the next layout over the content area and gives the content its own opacity back when cleared", () => {
        const content = addContent();
        expect(prepareLeave("ws-beta", Layout)).toBe(true);
        const frames = layer(LeaveLayerId).children;
        expect(frames.map((f) => [f.style.left, f.style.width])).toEqual([
            ["264px", "668px"],
            ["932px", "668px"],
        ]);
        leaveProgress(0.4);
        expect(content.style.opacity).toBe("0.6");
        expect(layer(LeaveLayerId).style.opacity).toBe("0.4");
        clearLeave();
        expect(content.style.opacity).toBe("");
        expect(layer(LeaveLayerId)).toBeNull();
        expect(leaving()).toBe(false);
    });

    it("draws nothing, and the switch shows no layout, for a layout of another view than the one the workspace shows", () => {
        addContent();
        wos.activeTab.set("ws-beta", "tab-other");
        expect(prepareLeave("ws-beta", Layout)).toBe(false);
        expect(layer(LeaveLayerId)).toBeNull();
        wos.activeTab.set("ws-beta", "tab-beta");
        expect(prepareLeave("ws-beta", Layout)).toBe(true);
    });

    it("draws nothing with the kill switch on", () => {
        addContent();
        (globalThis as any).api = { getEnv: (n: string) => (n === "MOLTENTERM_SWITCHPICTURE" ? "picture" : null) };
        resetSwitchLayoutFlag();
        expect(prepareLeave("ws-beta", Layout)).toBe(false);
    });

    it("lets the frames go LeaveMaxMs after the switch was asked, never before", () => {
        const content = addContent();
        prepareLeave("ws-beta", Layout);
        leaveProgress(1);
        holdLeave();
        vi.advanceTimersByTime(LeaveMaxMs - 1);
        expect(leaving()).toBe(true);
        vi.advanceTimersByTime(1);
        expect(leaving()).toBe(false);
        expect(content.style.opacity).toBe("");
    });

    for (const [what, act] of [
        ["main says it made no switch here", () => switchRefused()],
        ["main's script calls the page's hook", () => (globalThis as any).__mtSwitchLayoutRefused()],
        ["the window loses the focus", () => page.window.dispatch("blur")],
        ["the next press", () => page.window.dispatch("pointerdown")],
        ["the next key", () => page.window.dispatch("keydown")],
        ["the view leaves the screen", () => setVisibility("hidden")],
    ] as const) {
        it(`gives the content back at once when ${what}`, () => {
            page.document.visibilityState = "visible";
            const content = addContent();
            prepareLeave("ws-beta", Layout);
            leaveProgress(1);
            holdLeave();
            act();
            expect(leaving()).toBe(false);
            expect(content.style.opacity).toBe("");
            expect(layer(LeaveLayerId)).toBeNull();
        });
    }

    it("ends a dot's fade on its own leave, and says so", async () => {
        addContent();
        prepareLeave("ws-beta", Layout);
        const ended = playLeave(180);
        vi.advanceTimersByTime(180);
        await expect(ended).resolves.toBe(true);
    });

    it("tells a dot's fade that a swipe replaced its leave, and stops its animation", async () => {
        addContent();
        prepareLeave("ws-beta", Layout);
        const first = layer(LeaveLayerId);
        const ended = playLeave(180);
        vi.advanceTimersByTime(60);
        // A swipe starts toward another workspace: a new leave, while the old fade still runs.
        prepareLeave("ws-gamma", { ...Layout, workspaceId: "ws-gamma", tabId: "tab-gamma" });
        expect(leaving()).toBe(true);
        expect(first.getAnimations()).toHaveLength(0);
        vi.advanceTimersByTime(200);
        await expect(ended).resolves.toBe(false);
    });
});

describe("the frames worn by the view reached (#2407)", () => {
    it("refuses a layout of another view of the workspace", () => {
        addContent();
        expect(wearArrival(Layout, "tab-other")).toBe(false);
        expect(arriving()).toBe(false);
    });

    it("wears the frames, each with its dominoes, before the view is on screen", () => {
        addContent();
        expect(wearArrival(Layout, "tab-beta")).toBe(true);
        const frames = layer(ArrivalLayerId).children;
        expect(frames).toHaveLength(2);
        expect(frames.every((f) => f.querySelector(".df-dominos") != null)).toBe(true);
    });

    it("draws them at the window's size before the content area exists (a new view's first render)", () => {
        page.window.innerWidth = 1000;
        page.window.innerHeight = 700;
        wearArrival(Layout, "tab-beta");
        const frames = layer(ArrivalLayerId).children;
        expect(frames.map((f) => [f.style.left, f.style.width, f.style.height])).toEqual([
            ["264px", "368px", "700px"],
            ["632px", "368px", "700px"],
        ]);
    });

    it("lets every frame go ArrivalMaxMs after it was put on, even when its reveal never runs", () => {
        page.document.visibilityState = "visible";
        // A page that runs no animation frame: only the deadline is left.
        vi.stubGlobal("requestAnimationFrame", () => 0);
        addContent();
        wearArrival(Layout, "tab-beta");
        vi.advanceTimersByTime(ArrivalMaxMs - 1);
        expect(arriving()).toBe(true);
        vi.advanceTimersByTime(1);
        expect(arriving()).toBe(false);
        expect(layer(ArrivalLayerId)).toBeNull();
    });

    it("dissolves each frame once its panel has been ready on two frames, then goes", () => {
        page.document.visibilityState = "visible";
        const content = addContent();
        wearArrival(Layout, "tab-beta");
        arrivedOnScreen();
        vi.advanceTimersByTime(100);
        expect(layer(ArrivalLayerId).children).toHaveLength(2);
        mountBlock(content, "b1", { left: 268, top: 4, width: 660, height: 990 });
        // Seen ready on one frame only: its content may not have painted yet.
        vi.advanceTimersByTime(16);
        expect(layer(ArrivalLayerId).children[0].style.opacity).toBeUndefined();
        vi.advanceTimersByTime(32);
        // b1's frame snapped to its panel and dissolves; b2's waits.
        const [f1, f2] = layer(ArrivalLayerId).children;
        expect([f1.style.left, f1.style.width, f1.style.opacity]).toEqual(["268px", "660px", "0"]);
        expect(f1.getAnimations()).toHaveLength(1);
        expect(f2.style.opacity).toBeUndefined();
        vi.advanceTimersByTime(150);
        expect(layer(ArrivalLayerId).children.map((f) => f.dataset.panel)).toEqual(["b2"]);
        mountBlock(content, "b2", { left: 936, top: 4, width: 660, height: 990 });
        vi.advanceTimersByTime(400);
        expect(arriving()).toBe(false);
    });

    it("starts revealing ArrivalOnScreenFallbackMs after it was worn when main never says the view is on screen", () => {
        page.document.visibilityState = "visible";
        const content = addContent();
        mountBlock(content, "b1", { left: 268, top: 4, width: 660, height: 990 });
        mountBlock(content, "b2", { left: 936, top: 4, width: 660, height: 990 });
        wearArrival(Layout, "tab-beta");
        vi.advanceTimersByTime(ArrivalOnScreenFallbackMs - 1);
        expect(layer(ArrivalLayerId).children).toHaveLength(2);
        vi.advanceTimersByTime(400);
        expect(arriving()).toBe(false);
    });

    it("lets a frame whose panel never comes go ArrivalPanelMaxMs after the view came on screen", () => {
        page.document.visibilityState = "visible";
        addContent();
        wearArrival(Layout, "tab-beta");
        arrivedOnScreen();
        vi.advanceTimersByTime(ArrivalPanelMaxMs - 20);
        expect(layer(ArrivalLayerId).children).toHaveLength(2);
        vi.advanceTimersByTime(400);
        expect(arriving()).toBe(false);
    });

    it("goes once the view stays hidden after it came on screen, but not for main's blip at the swap", () => {
        page.document.visibilityState = "visible";
        addContent();
        wearArrival(Layout, "tab-beta");
        arrivedOnScreen();
        setVisibility("hidden");
        vi.advanceTimersByTime(30);
        setVisibility("visible");
        vi.advanceTimersByTime(400);
        expect(arriving()).toBe(true);
        setVisibility("hidden");
        vi.advanceTimersByTime(400);
        expect(arriving()).toBe(false);
    });
});
