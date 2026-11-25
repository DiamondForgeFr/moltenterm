// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The comment overlay in the page (FR-BRW-017 AC28, #2422): nothing of it exists before the panel starts it, nothing is left
// once it stops, whatever was waiting on the page when it stopped touches nothing, and only the developer's own events
// count. No DOM implementation is installed for the tests (jsdom is no dependency of the project: adding one touches the
// lockfile and the dependency policy), so this file holds a small fake of exactly the DOM the overlay touches, and a fake
// clock for the frames and timers it waits on.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type Anchor,
    AnnotateChannel,
    type MarkView,
    type StartMessage,
} from "../frontend/moltenterm-shell/browser/annotate-wire";

const { ipc } = vi.hoisted(() => {
    const state = {
        handler: null as (event: unknown, msg: unknown) => void,
        registered: 0,
        posted: [] as any[],
        on(_channel: string, fn: (event: unknown, msg: unknown) => void) {
            state.handler = fn;
            state.registered++;
        },
        sendToHost(_channel: string, msg: unknown) {
            state.posted.push(msg);
        },
    };
    return { ipc: state };
});

vi.mock("electron", () => ({ ipcRenderer: ipc }));

import { installAnnotateGuest } from "./moltenterm-annotate-guest";

// ---- the fake DOM -------------------------------------------------------------------------------------------------

const targets: FakeTarget[] = [];

class FakeTarget {
    handlers = new Map<string, Set<(e: any) => void>>();

    constructor() {
        targets.push(this);
    }

    addEventListener(type: string, fn: (e: any) => void) {
        const set = this.handlers.get(type) ?? new Set();
        set.add(fn);
        this.handlers.set(type, set);
    }

    removeEventListener(type: string, fn: (e: any) => void) {
        this.handlers.get(type)?.delete(fn);
    }

    emit(type: string, event: any) {
        for (const fn of [...(this.handlers.get(type) ?? [])]) {
            fn(event);
        }
    }

    count(type?: string): number {
        return type != null
            ? (this.handlers.get(type)?.size ?? 0)
            : [...this.handlers.values()].reduce((n, set) => n + set.size, 0);
    }
}

const listenerCount = () => targets.reduce((n, t) => n + t.count(), 0);

class FakeShadow extends FakeTarget {
    children: FakeElement[] = [];
    adoptedStyleSheets: unknown[] = [];

    append(...nodes: FakeElement[]) {
        for (const node of nodes) {
            node.parentElement = null;
            this.children.push(node);
        }
    }
}

class FakeElement extends FakeTarget {
    nodeType = 1;
    id = "";
    className = "";
    textContent = "";
    children: FakeElement[] = [];
    parentElement: FakeElement = null;
    attrs = new Map<string, string>();
    props: Record<string, string> = {};
    style = {
        setProperty: (key: string, value: string) => {
            this.props[key] = value;
        },
    } as Record<string, any>;
    rect = { left: 0, top: 0, width: 0, height: 0 };
    scrollHeight = 0;
    clientHeight = 0;
    scrollWidth = 0;
    clientWidth = 0;
    scrollLeft = 0;
    scrollTop = 0;
    shadow: FakeShadow = null;
    classes = new Set<string>();
    scrolledIntoView = 0;
    onScrollIntoView: () => void = () => {};
    classList = {
        add: (c: string) => this.classes.add(c),
        remove: (c: string) => this.classes.delete(c),
        toggle: (c: string, force?: boolean) => {
            const on = force ?? !this.classes.has(c);
            if (on) {
                this.classes.add(c);
            } else {
                this.classes.delete(c);
            }
            return on;
        },
        contains: (c: string) => this.classes.has(c),
        [Symbol.iterator]: () => this.classes.values(),
    };
    pointerCaptured = 0;

    constructor(public tagName: string) {
        super();
    }

    get isConnected(): boolean {
        const top = (node: FakeElement): FakeElement => (node.parentElement == null ? node : top(node.parentElement));
        return top(this) === documentElement;
    }

    appendChild(node: FakeElement) {
        node.remove();
        node.parentElement = this;
        this.children.push(node);
        return node;
    }

    append(...nodes: FakeElement[]) {
        for (const node of nodes) {
            this.appendChild(node);
        }
    }

    replaceChildren(...nodes: FakeElement[]) {
        for (const child of this.children) {
            child.parentElement = null;
        }
        this.children = [];
        this.append(...nodes);
    }

    remove() {
        if (this.parentElement != null) {
            this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
            this.parentElement = null;
        }
    }

    attachShadow() {
        this.shadow = new FakeShadow();
        return this.shadow;
    }

    getBoundingClientRect() {
        return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height };
    }

    getAttribute(name: string) {
        return this.attrs.get(name) ?? null;
    }

    setAttribute(name: string, value: string) {
        this.attrs.set(name, value);
    }

    setPointerCapture() {
        this.pointerCaptured++;
    }

    scrollIntoView() {
        this.scrolledIntoView++;
        this.onScrollIntoView();
    }

    blur = vi.fn();
}

let documentElement: FakeElement;
let body: FakeElement;
const named = new Map<string, FakeElement>();

class FakeObserver {
    static all: FakeObserver[] = [];
    observing = false;

    constructor(public callback: (records: any[]) => void) {
        FakeObserver.all.push(this);
    }

    observe() {
        this.observing = true;
    }

    disconnect() {
        this.observing = false;
    }

    static active(): number {
        return FakeObserver.all.filter((o) => o.observing).length;
    }
}

class FakeWindow extends FakeTarget {
    scrollX = 0;
    scrollY = 0;
    innerWidth = 1000;
    innerHeight = 800;
    scrolls: { left: number; top: number }[] = [];

    scrollTo(options: { left: number; top: number }) {
        this.scrolls.push({ left: options.left, top: options.top });
        const max = Math.max(0, documentElement.scrollHeight - this.innerHeight);
        this.scrollX = options.left;
        this.scrollY = Math.min(max, Math.max(0, options.top));
    }

    setTimeout(fn: () => void, ms: number) {
        return setTimeout(fn, ms) as unknown as number;
    }

    clearTimeout(id: number) {
        clearTimeout(id);
    }
}

let fakeWindow: FakeWindow;
let styles: { position: string; overflowX: string; overflowY: string };

function installFakeDom() {
    targets.length = 0;
    FakeObserver.all = [];
    named.clear();
    documentElement = new FakeElement("HTML");
    body = new FakeElement("BODY");
    documentElement.appendChild(body);
    documentElement.scrollHeight = 3000;
    documentElement.scrollWidth = 1000;
    fakeWindow = new FakeWindow();
    styles = { position: "static", overflowX: "visible", overflowY: "visible" };
    const doc = {
        documentElement,
        body,
        scrollingElement: documentElement,
        activeElement: body as FakeElement,
        createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
        createElementNS: (_ns: string, tag: string) => new FakeElement(tag.toUpperCase()),
        elementsFromPoint: () => [] as FakeElement[],
        querySelector: (selector: string) => named.get(selector) ?? null,
        querySelectorAll: (selector: string) => (named.has(selector) ? [named.get(selector)] : []),
    };
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("location", { href: "http://localhost:5422/index.html" });
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    vi.stubGlobal(
        "CSSStyleSheet",
        class {
            replaceSync() {}
        }
    );
    vi.stubGlobal("ResizeObserver", FakeObserver);
    vi.stubGlobal("MutationObserver", FakeObserver);
    vi.stubGlobal("getComputedStyle", () => styles);
    vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => setTimeout(() => cb(0), 16));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    return doc;
}

// ---- the overlay under test -----------------------------------------------------------------------------------------

const Card: Anchor = {
    box: { x: 100, y: 2000, w: 200, h: 100 },
    selector: "#card",
    rel: { x: 0, y: 0, w: 1, h: 1 },
    fixed: false,
    path: null,
};

const mark = (change: Partial<MarkView> = {}): MarkView => ({
    id: 1,
    n: 1,
    kind: "zone",
    anchor: Card,
    active: false,
    ...change,
});

const start = (change: Partial<StartMessage> = {}): StartMessage => ({
    type: "start",
    color: "orange",
    tool: "point",
    paused: false,
    marks: [mark()],
    ...change,
});

const send = (msg: unknown) => ipc.handler(null, msg);
const hosts = () => documentElement.children.filter((c) => c.tagName === "MOLTEN-ANNOTATE");
const posted = (type: string) => ipc.posted.filter((m) => m.type === type);

// The element a mark is on, in the page at (100, 2000).
function putCard() {
    const card = new FakeElement("DIV");
    card.id = "card";
    card.rect = { left: 100, top: 2000, width: 200, height: 100 };
    body.appendChild(card);
    named.set("#card", card);
    return card;
}

beforeAll(() => {
    installFakeDom();
    installAnnotateGuest();
});

beforeEach(() => {
    vi.useFakeTimers();
    installFakeDom();
    ipc.posted = [];
});

afterEach(() => {
    // Whatever a test left started is stopped, so the next one begins with no overlay.
    send({ type: "stop" });
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("before the panel starts the mode", () => {
    it("has done one thing only: it listens for the panel's message", () => {
        expect(ipc.registered).toBe(1);
        expect(AnnotateChannel).toBe("moltenterm-annotate");
        expect(hosts()).toHaveLength(0);
        expect(listenerCount()).toBe(0);
        expect(FakeObserver.all).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("ignores a message to an overlay there is not, and answers a request as a failure, echoing its number", () => {
        send({ type: "tool", tool: "zone" });
        send({ type: "marks", marks: [mark()] });
        expect(hosts()).toHaveLength(0);
        expect(ipc.posted).toEqual([]);
        send({ type: "prepare", reqId: 11, id: 1 });
        send({ type: "overview", reqId: 12, slice: 0 });
        send({ type: "restore", reqId: 13 });
        expect(posted("prepared")).toMatchObject([{ reqId: 11, ok: false, reason: "gone" }]);
        expect(posted("overview")).toMatchObject([{ reqId: 12, ok: false, whole: false, marks: [] }]);
        expect(posted("restored")).toEqual([{ type: "restored", reqId: 13 }]);
        expect(hosts()).toHaveLength(0);
        expect(listenerCount()).toBe(0);
    });
});

describe("a started overlay", () => {
    it("is one closed element in the document, with its listeners and observers", () => {
        send(start());
        expect(hosts()).toHaveLength(1);
        expect(hosts()[0].shadow).not.toBeNull();
        expect(fakeWindow.count("scroll")).toBe(1);
        expect(fakeWindow.count("resize")).toBe(1);
        expect(fakeWindow.count("keydown")).toBe(1);
        expect(FakeObserver.active()).toBe(2);
        // Starting again changes the marks, never makes a second overlay.
        send(start({ marks: [] }));
        expect(hosts()).toHaveLength(1);
        expect(FakeObserver.active()).toBe(2);
    });

    it("leaves the focus where the page had put it from the tools' point of view: the focused element is blurred", () => {
        const input = new FakeElement("INPUT");
        body.appendChild(input);
        (document as any).activeElement = input;
        send(start());
        expect(input.blur).toHaveBeenCalledTimes(1);
    });

    it("says to the panel which comments' element the page no longer has, once", () => {
        send(start());
        expect(posted("found")).toEqual([{ type: "found", missing: [1] }]);
        putCard();
        send({ type: "marks", marks: [mark()] });
        expect(posted("found")).toEqual([
            { type: "found", missing: [1] },
            { type: "found", missing: [] },
        ]);
        send({ type: "marks", marks: [mark()] });
        expect(posted("found")).toHaveLength(2);
    });
});

describe("a stopped overlay (the guard of what is left in the page)", () => {
    it("leaves no element, listener, observer or timer", async () => {
        putCard();
        send(start());
        const [host] = hosts();
        const capture = host.shadow.children[1];
        expect(capture.count()).toBeGreaterThan(0);
        send({ type: "stop" });
        await vi.advanceTimersByTimeAsync(1000);
        expect(hosts()).toHaveLength(0);
        expect(host.isConnected).toBe(false);
        expect(listenerCount()).toBe(0);
        expect(FakeObserver.active()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("puts the page back where the developer left it, and its scrolling areas, even when a capture was under way", async () => {
        const card = putCard();
        const area = new FakeElement("DIV");
        area.scrollHeight = 2000;
        area.clientHeight = 400;
        area.scrollTop = 120;
        card.remove();
        area.appendChild(card);
        body.appendChild(area);
        card.onScrollIntoView = () => {
            fakeWindow.scrollY = 1600;
            area.scrollTop = 900;
        };
        fakeWindow.scrollY = 300;
        send(start());
        send({ type: "prepare", reqId: 5, id: 1 });
        // The capture has scrolled the page and the area, and waits for them to settle.
        expect(fakeWindow.scrollY).toBe(1600);
        expect(area.scrollTop).toBe(900);
        send({ type: "stop" });
        expect(fakeWindow.scrollY).toBe(300);
        expect(area.scrollTop).toBe(120);
        await vi.advanceTimersByTimeAsync(1000);
        expect(fakeWindow.scrollY).toBe(300);
    });

    it("is not put back in the document, nor made to say or scroll anything, by a prepare that was waiting on the page", async () => {
        putCard().onScrollIntoView = () => {
            fakeWindow.scrollY = 1600;
        };
        send(start());
        send({ type: "prepare", reqId: 7, id: 1 });
        send({ type: "stop" });
        const scrolls = fakeWindow.scrolls.length;
        await vi.advanceTimersByTimeAsync(2000);
        expect(hosts()).toHaveLength(0);
        expect(posted("prepared")).toEqual([]);
        expect(fakeWindow.scrolls).toHaveLength(scrolls);
        expect(fakeWindow.scrollY).toBe(0);
        expect(listenerCount()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("is not put back in the document by an overview, a restore or a reveal that was waiting on the page", async () => {
        putCard();
        send(start());
        send({ type: "overview", reqId: 8, slice: 1 });
        send({ type: "restore", reqId: 9 });
        send({ type: "reveal", id: 1 });
        send({ type: "stop" });
        await vi.advanceTimersByTimeAsync(2000);
        expect(hosts()).toHaveLength(0);
        expect(posted("overview")).toEqual([]);
        expect(posted("restored")).toEqual([]);
        expect(listenerCount()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("is not brought back by a change of the page that was already scheduled", async () => {
        putCard();
        send(start());
        const [resize] = FakeObserver.all;
        resize.callback([]);
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        send({ type: "stop" });
        await vi.advanceTimersByTimeAsync(1000);
        expect(hosts()).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("only the developer's own events count", () => {
    const pointer = (isTrusted: boolean) => ({
        isTrusted,
        button: 0,
        pointerId: 1,
        clientX: 40,
        clientY: 60,
        preventDefault: vi.fn(),
    });

    function capture(): FakeElement {
        return hosts()[0].shadow.children[1];
    }

    it("takes a press the developer made, and nothing a script of the page makes up", () => {
        send(start());
        capture().emit("pointerdown", pointer(false));
        capture().emit("pointermove", pointer(false));
        capture().emit("pointerup", pointer(false));
        expect(ipc.posted.filter((m) => m.type === "press" || m.type === "placed" || m.type === "edit")).toEqual([]);
        expect(capture().pointerCaptured).toBe(0);
        capture().emit("pointerdown", pointer(true));
        expect(posted("press")).toHaveLength(1);
        expect(capture().pointerCaptured).toBe(1);
    });

    it("takes the developer's Escape, and not a script's", () => {
        send(start());
        const key = (isTrusted: boolean) => ({
            isTrusted,
            key: "Escape",
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        });
        fakeWindow.emit("keydown", key(false));
        expect(posted("key")).toEqual([]);
        fakeWindow.emit("keydown", key(true));
        expect(posted("key")).toEqual([{ type: "key", key: "Escape" }]);
    });

    it("takes nothing while paused, and no press while the pictures are taken", () => {
        send(start({ paused: true }));
        capture().emit("pointerdown", pointer(true));
        expect(posted("press")).toEqual([]);
        expect(capture().classes.has("paused")).toBe(true);
        send({ type: "lock", locked: true });
        capture().emit("pointerdown", pointer(true));
        expect(posted("press")).toEqual([]);
    });
});

describe("the capture lock", () => {
    function capture(): FakeElement {
        return hosts()[0].shadow.children[1];
    }

    it("keeps the layer over a paused page, blocks the wheel and the scrolling keys while locked, and lets go after", () => {
        send(start({ paused: true }));
        expect(capture().classes.has("paused")).toBe(true);
        expect(capture().count("wheel")).toBe(0);
        send({ type: "lock", locked: true });
        expect(capture().classes.has("locked")).toBe(true);
        expect(capture().classes.has("paused")).toBe(false);
        expect(capture().count("wheel")).toBe(1);
        const wheel = { preventDefault: vi.fn() };
        capture().emit("wheel", wheel);
        expect(wheel.preventDefault).toHaveBeenCalled();
        const arrow = { isTrusted: true, key: "ArrowDown", preventDefault: vi.fn(), stopPropagation: vi.fn() };
        fakeWindow.emit("keydown", arrow);
        expect(arrow.preventDefault).toHaveBeenCalled();
        const letter = { isTrusted: true, key: "a", preventDefault: vi.fn(), stopPropagation: vi.fn() };
        fakeWindow.emit("keydown", letter);
        expect(letter.preventDefault).not.toHaveBeenCalled();
        send({ type: "lock", locked: false });
        expect(capture().classes.has("locked")).toBe(false);
        expect(capture().classes.has("paused")).toBe(true);
        expect(capture().count("wheel")).toBe(0);
    });

    it("still gives the developer's Escape, which cancels the capture", () => {
        send(start({ paused: true }));
        send({ type: "lock", locked: true });
        fakeWindow.emit("keydown", {
            isTrusted: true,
            key: "Escape",
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        });
        expect(posted("key")).toHaveLength(1);
    });

    it("keeps only the marks out of sight for a picture, never the layer that holds the page, and lets go on stop", () => {
        putCard();
        send(start());
        send({ type: "lock", locked: true });
        send({ type: "prepare", reqId: 3, id: 1 });
        const layer = hosts()[0].shadow.children[0];
        const over = capture();
        expect(layer.style.visibility).toBe("hidden");
        expect(over.classes.has("locked")).toBe(true);
        expect(over.count("wheel")).toBe(1);
        send({ type: "stop" });
        expect(over.count("wheel")).toBe(0);
        expect(over.count()).toBe(0);
    });
});

describe("what a mark is on", () => {
    it("follows the page's scrolling frame by frame for an element that moves with the viewport, and only then", async () => {
        const card = putCard();
        send(start({ marks: [mark({ anchor: { ...Card, sticky: true } })] }));
        let count = 0;
        card.getBoundingClientRect = () => {
            count++;
            return { left: 100, top: 2000, width: 200, height: 100, right: 300, bottom: 2100 };
        };
        const before = count;
        fakeWindow.emit("scroll", { target: document });
        await vi.advanceTimersByTimeAsync(40);
        expect(count).toBeGreaterThan(before);
        send({ type: "marks", marks: [mark()] });
        const settled = count;
        fakeWindow.emit("scroll", { target: document });
        await vi.advanceTimersByTimeAsync(400);
        expect(count).toBe(settled);
    });

    it("is read again at most every so often when the page changes by script, and not for the overlay's own element", async () => {
        const card = putCard();
        send(start());
        let reads = 0;
        card.getBoundingClientRect = () => {
            reads++;
            return { left: 100, top: 2000, width: 200, height: 100, right: 300, bottom: 2100 };
        };
        await vi.advanceTimersByTimeAsync(500);
        const [, mutations] = FakeObserver.all;
        const own = hosts()[0];
        const base = reads;
        mutations.callback([{ target: own }]);
        await vi.advanceTimersByTimeAsync(500);
        expect(reads).toBe(base);
        for (let i = 0; i < 20; i++) {
            mutations.callback([{ target: card }]);
        }
        await vi.advanceTimersByTimeAsync(500);
        expect(reads - base).toBe(1);
    });
});

describe("what the developer sees while drawing and pointing (#2537)", () => {
    const at = (x: number, y: number) => ({
        isTrusted: true,
        button: 0,
        pointerId: 7,
        clientX: x,
        clientY: y,
        preventDefault: vi.fn(),
    });

    const layer = (): FakeElement => hosts()[0].shadow.children[0];
    const capture = (): FakeElement => hosts()[0].shadow.children[1];
    // The draft and the preview as the page shows them: only what is in the layer is on screen.
    const shown = (cls: string): FakeElement =>
        layer().children.find((c) => c.className.split(" ").includes(cls) && c.style.display === "block") ?? null;
    const placedAt = (el: FakeElement) => ({
        left: el.style.left,
        top: el.style.top,
        width: el.style.width,
        height: el.style.height,
    });

    // An element in view at (100, 200), 200 by 100, that the page has under the pointer.
    function putButton() {
        const button = new FakeElement("BUTTON");
        button.id = "buy";
        button.rect = { left: 100, top: 200, width: 200, height: 100 };
        body.appendChild(button);
        named.set("#buy", button);
        (document as any).elementsFromPoint = () => [button, body];
        return button;
    }

    it("draws the rectangle from the press and follows the pointer, before the release", () => {
        send(start({ tool: "zone" }));
        capture().emit("pointerdown", at(40, 60));
        expect(shown("draft")).not.toBeNull();
        capture().emit("pointermove", at(140, 160));
        expect(placedAt(shown("draft"))).toEqual({ left: "40px", top: "60px", width: "100px", height: "100px" });
        capture().emit("pointermove", at(240, 110));
        expect(placedAt(shown("draft"))).toEqual({ left: "40px", top: "60px", width: "200px", height: "50px" });
        expect(posted("placed")).toEqual([]);
        capture().emit("pointerup", at(240, 110));
        expect(shown("draft")).toBeNull();
        expect(posted("placed")).toHaveLength(1);
    });

    it("draws the pencil's stroke while the pointer moves, one more point at each move", () => {
        send(start({ tool: "freehand" }));
        capture().emit("pointerdown", at(40, 60));
        const points = () => shown("draft").children[0].children[0].attrs.get("points").split(" ").length;
        capture().emit("pointermove", at(80, 60));
        expect(points()).toBe(2);
        capture().emit("pointermove", at(120, 90));
        capture().emit("pointermove", at(160, 140));
        expect(points()).toBe(4);
        expect(placedAt(shown("draft"))).toEqual({ left: "40px", top: "60px", width: "120px", height: "80px" });
    });

    it("keeps the draft in the page when the panel sends the marks again during the gesture", () => {
        send(start({ tool: "zone" }));
        capture().emit("pointerdown", at(40, 60));
        send({ type: "marks", marks: [mark()] });
        capture().emit("pointermove", at(140, 160));
        expect(placedAt(shown("draft"))).toEqual({ left: "40px", top: "60px", width: "100px", height: "100px" });
    });

    it("outlines, under the cursor tool, the very element the click then selects", () => {
        putButton();
        send(start({ tool: "point", marks: [] }));
        capture().emit("pointermove", at(150, 250));
        const preview = shown("hover");
        expect(preview).not.toBeNull();
        expect(placedAt(preview)).toEqual({ left: "100px", top: "200px", width: "200px", height: "100px" });
        capture().emit("pointerdown", at(150, 250));
        capture().emit("pointerup", at(150, 250));
        const [placed] = posted("placed");
        expect(placed.anchor.selector).toBe("#buy");
        expect(placed.anchor.fixed).toBe(false);
        expect(placed.anchor.box).toEqual({ x: 100, y: 200, w: 200, h: 100 });
    });

    it("follows the page when it scrolls under a still pointer", () => {
        putButton();
        send(start({ tool: "point", marks: [] }));
        capture().emit("pointermove", at(150, 250));
        expect(placedAt(shown("hover"))).toEqual({ left: "100px", top: "200px", width: "200px", height: "100px" });
        // The page goes up by 50 under the pointer, which is now over the next element.
        const next = new FakeElement("P");
        next.rect = { left: 100, top: 240, width: 300, height: 40 };
        body.appendChild(next);
        (document as any).elementsFromPoint = () => [next, body];
        fakeWindow.scrollY = 50;
        hosts()[0].rect = { left: 0, top: -50, width: 0, height: 0 };
        fakeWindow.emit("scroll", { target: document });
        expect(placedAt(shown("hover"))).toEqual({ left: "100px", top: "290px", width: "300px", height: "40px" });
    });

    it("outlines nothing where the click selects no element: a too large one, a comment, another tool", () => {
        const button = putButton();
        send(start({ tool: "point", marks: [] }));
        button.rect = { left: 0, top: 0, width: 1000, height: 800 };
        capture().emit("pointermove", at(150, 250));
        expect(shown("hover")).toBeNull();
        capture().emit("pointerdown", at(150, 250));
        capture().emit("pointerup", at(150, 250));
        expect(posted("placed")[0].anchor.fixed).toBe(true);
        button.rect = { left: 100, top: 200, width: 200, height: 100 };
        const onIt: Anchor = {
            box: { x: 120, y: 220, w: 50, h: 50 },
            selector: "",
            rel: null,
            fixed: true,
            path: null,
        };
        send({ type: "marks", marks: [mark({ anchor: onIt })] });
        capture().emit("pointermove", at(150, 250));
        expect(shown("hover")).toBeNull();
        send({ type: "tool", tool: "freehand" });
        capture().emit("pointermove", at(250, 280));
        expect(shown("hover")).toBeNull();
    });
});
