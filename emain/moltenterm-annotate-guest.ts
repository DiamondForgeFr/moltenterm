// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The comment overlay inside a web page panel's page (FR-BRW-017, DS-BRW-024, #2422). The page's preload installs it
// (emain/preload-webview.ts); it does nothing until the panel's layer sends `start`, and `stop` removes every trace of it:
// the element, the observers, the listeners and the timers. While it runs the page stays live: the marks live in a layer
// at the document's origin, so the page's own scrolling carries them; a transparent capture layer over the viewport takes
// the pointer for the tool in use and lets the wheel through; paused, it takes nothing. The rules of the anchors, the
// gestures and the geometry are in annotate-anchor.ts; what the panel and this file say to each other is annotate-wire.ts.

import { ipcRenderer } from "electron";
import {
    anchorOf,
    boxOfPoints,
    buildSelector,
    gestureOf,
    hitMark,
    type NodeFacts,
    pathFractions,
    pathPoints,
    pickAnchorIndex,
    resolveAnchor,
    scrollTarget,
    simplifyPath,
    toViewport,
    visibleFraction,
} from "../frontend/moltenterm-shell/browser/annotate-anchor";
import {
    AnnotateChannel,
    type Box,
    type FromGuest,
    type MarkKind,
    type MarkView,
    MaxOverviewScreens,
    type Point,
    type Size,
    type StartMessage,
    type ToGuest,
} from "../frontend/moltenterm-shell/browser/annotate-wire";

// An unknown element name: the page's own rules for div or span never reach it.
const HostTag = "molten-annotate";
const SettleMs = 150;
const SettleTries = 4;
// An element covering more of the viewport than this is not a mark's target: the click draws a marker on it instead.
const BigElement = 0.6;
const FlashMs = 1900;
// The page's own changes (a script moving an element) are read again at most this often.
const MinRefreshMs = 120;
// A mark seen less than this much, once a scrolling area of the page has clipped it, has no picture.
const SeenAtLeast = 0.5;
const ScrollKeys = new Set([
    " ",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
]);

const Css = `
:host { all: initial; }
.layer { position: absolute; left: 0; top: 0; width: 0; height: 0; overflow: visible; pointer-events: none; }
.mk { position: absolute; box-sizing: border-box; border: 2px solid var(--c); border-radius: 3px; background: color-mix(in srgb, var(--c) 12%, transparent); pointer-events: none; }
.mk.active { border-width: 3px; background: color-mix(in srgb, var(--c) 26%, transparent); }
.mk.freehand { border: 0; background: none; }
.mk svg { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: visible; }
.mk polyline { fill: none; stroke: var(--c); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.bd { position: absolute; left: -11px; top: -11px; width: 22px; height: 22px; border-radius: 50%; background: var(--c); color: #fff; font: 700 12px/22px system-ui, sans-serif; text-align: center; box-shadow: 0 0 0 2px #fff; }
.mk.flash { animation: flash 0.95s ease-out 2; }
@keyframes flash { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--c) 75%, transparent); } 100% { box-shadow: 0 0 0 18px transparent; } }
.draft, .hover { position: absolute; box-sizing: border-box; pointer-events: none; }
.draft.zone { border: 2px dashed var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); }
.hover { border: 2px dashed var(--c); background: color-mix(in srgb, var(--c) 8%, transparent); }
.draft svg { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: visible; }
.draft polyline { fill: none; stroke: var(--c); stroke-width: 3; stroke-dasharray: 2 5; stroke-linecap: round; stroke-linejoin: round; }
.capture { position: fixed; left: 0; top: 0; right: 0; bottom: 0; cursor: crosshair; user-select: none; -webkit-user-select: none; touch-action: none; pointer-events: auto; }
.capture.paused { pointer-events: none; }
.capture.locked { cursor: progress; pointer-events: auto; }
`;

type Drag = { pointerId: number; down: Point; path: Point[] };

type Overlay = {
    host: HTMLElement;
    root: ShadowRoot;
    layer: HTMLElement;
    capture: HTMLElement;
    hover: HTMLElement;
    draft: HTMLElement;
    color: string;
    tool: MarkKind;
    paused: boolean;
    // The pictures are being taken: the page takes nothing from the developer.
    locked: boolean;
    // Set by destroy: whatever was waiting on the page (a scroll, a frame) finds the overlay gone and touches nothing.
    dead: boolean;
    marks: MarkView[];
    nodes: Map<number, HTMLElement>;
    boxes: Map<number, Box>;
    // The comments whose element the page no longer has, as last said to the panel.
    missing: Set<number>;
    missingKey: string;
    // Some mark is on an element that moves with the viewport.
    sticky: boolean;
    tracked: number;
    lastView: string;
    // Where the developer had scrolled the page, and its scrolling areas, before a capture moved them.
    saved: Point;
    inner: Map<Element, Point>;
    drag: Drag;
    frame: number;
    timer: number;
    lastRun: number;
    flashTimer: number;
    observer: ResizeObserver;
    mutations: MutationObserver;
    removers: (() => void)[];
    unlockWheel: () => void;
};

let overlay: Overlay = null;

function post(msg: FromGuest): void {
    ipcRenderer.sendToHost(AnnotateChannel, msg);
}

function scrolledTo(): Point {
    return { x: window.scrollX, y: window.scrollY };
}

function viewportSize(): Size {
    return { w: window.innerWidth, h: window.innerHeight };
}

function pageSize(): Size {
    const el = document.scrollingElement ?? document.documentElement;
    return { w: el.scrollWidth, h: el.scrollHeight };
}

function pageBoxOf(rect: DOMRect | DOMRectReadOnly): Box {
    const s = scrolledTo();
    return { x: rect.left + s.x, y: rect.top + s.y, w: rect.width, h: rect.height };
}

function settle(ms = SettleMs): Promise<void> {
    return new Promise((resolve) => {
        const timer = window.setTimeout(resolve, ms);
        requestAnimationFrame(() =>
            requestAnimationFrame(() => {
                window.clearTimeout(timer);
                resolve();
            })
        );
    });
}

function factsOf(el: Element): NodeFacts {
    if (el == null || el.nodeType !== 1) {
        return null;
    }
    const parent = el.parentElement;
    const tag = el.tagName;
    let sameTag = 1;
    let indexOfTag = 1;
    if (parent != null) {
        sameTag = 0;
        for (const sibling of Array.from(parent.children)) {
            if (sibling.tagName !== tag) {
                continue;
            }
            sameTag++;
            if (sibling === el) {
                indexOfTag = sameTag;
            }
        }
    }
    return {
        tag,
        id: el.id ?? "",
        testId: el.getAttribute("data-testid") ?? el.getAttribute("data-test-id") ?? el.getAttribute("data-test") ?? "",
        classes: Array.from(el.classList ?? []),
        sameTag,
        indexOfTag,
        parent: el === document.documentElement ? null : factsOf(parent),
    };
}

function selectorOf(el: Element): string {
    const facts = factsOf(el);
    if (facts == null) {
        return "";
    }
    const unique = (selector: string) => {
        try {
            return document.querySelectorAll(selector).length === 1;
        } catch {
            return false;
        }
    };
    return buildSelector(facts, unique, (s) => CSS.escape(s));
}

function elementBoxOf(selector: string): Box {
    let el: Element = null;
    try {
        el = document.querySelector(selector);
    } catch {
        return null;
    }
    if (el == null) {
        return null;
    }
    const box = pageBoxOf(el.getBoundingClientRect());
    return box.w > 0 && box.h > 0 ? box : null;
}

function originOf(o: Overlay): Point {
    const rect = o.host.getBoundingClientRect();
    const s = scrolledTo();
    return { x: rect.left + s.x, y: rect.top + s.y };
}

function polyline(points: number[]): SVGElement {
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("viewBox", "0 0 1 1");
    svg.setAttribute("preserveAspectRatio", "none");
    const line = document.createElementNS(svgNs, "polyline");
    const pts: string[] = [];
    for (let i = 0; i + 1 < points.length; i += 2) {
        pts.push(`${points[i].toFixed(4)},${points[i + 1].toFixed(4)}`);
    }
    line.setAttribute("points", pts.join(" "));
    svg.appendChild(line);
    return svg;
}

function buildMarkNode(mark: MarkView): HTMLElement {
    const node = document.createElement("div");
    node.className = `mk ${mark.kind}${mark.active ? " active" : ""}`;
    if (mark.kind === "freehand" && mark.anchor.path != null) {
        node.appendChild(polyline(mark.anchor.path));
    }
    const badge = document.createElement("span");
    badge.className = "bd";
    badge.textContent = String(mark.n);
    node.appendChild(badge);
    return node;
}

function placeNode(node: HTMLElement, box: Box, origin: Point): void {
    node.style.left = `${box.x - origin.x}px`;
    node.style.top = `${box.y - origin.y}px`;
    node.style.width = `${box.w}px`;
    node.style.height = `${box.h}px`;
}

function ensureAttached(o: Overlay): void {
    if (!o.dead && !o.host.isConnected) {
        document.documentElement.appendChild(o.host);
    }
}

// elementOf: the element a mark is on, null when it has none or the page no longer has it.
function elementOf(selector: string): Element {
    if (selector === "") {
        return null;
    }
    try {
        return document.querySelector(selector);
    } catch {
        return null;
    }
}

// movesWithViewport: the element, or one around it, is fixed or sticky.
function movesWithViewport(el: Element): boolean {
    for (let a = el; a != null; a = a.parentElement) {
        const position = getComputedStyle(a).position;
        if (position === "fixed" || position === "sticky") {
            return true;
        }
    }
    return false;
}

// The scrolling areas around an element, their offsets noted before a capture moves them, put back by restoreInner.
function saveInner(o: Overlay, el: Element): void {
    for (let a = el?.parentElement; a != null; a = a.parentElement) {
        if (a === document.documentElement || o.inner.has(a)) {
            continue;
        }
        if (a.scrollHeight > a.clientHeight || a.scrollWidth > a.clientWidth) {
            o.inner.set(a, { x: a.scrollLeft, y: a.scrollTop });
        }
    }
}

function restoreInner(o: Overlay): void {
    for (const [el, at] of o.inner) {
        el.scrollLeft = at.x;
        el.scrollTop = at.y;
    }
    o.inner.clear();
}

// clipsOf: the areas of the scrolling or clipping ancestors of an element, which cut it off from sight (in the viewport's
// pixels). The viewport is not one: a mark taller than it is still captured as far as it shows.
function clipsOf(el: Element): Box[] {
    const clips: Box[] = [];
    for (let a = el?.parentElement; a != null && a !== document.documentElement; a = a.parentElement) {
        const style = getComputedStyle(a);
        if (style.overflowX === "visible" && style.overflowY === "visible") {
            continue;
        }
        const r = a.getBoundingClientRect();
        clips.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return clips;
}

// restoreScroll: the page and its scrolling areas back where the developer left them.
function restoreScroll(o: Overlay): void {
    if (o.saved != null) {
        jump(o.saved);
        o.saved = null;
    }
    restoreInner(o);
}

function reportView(o: Overlay): void {
    if (o.tracked <= 0) {
        return;
    }
    const box = o.boxes.get(o.tracked);
    if (box == null) {
        return;
    }
    const view = toViewport(box, scrolledTo());
    const key = `${view.x}|${view.y}|${view.w}|${view.h}|${window.innerWidth}|${window.innerHeight}`;
    if (key === o.lastView) {
        return;
    }
    o.lastView = key;
    post({ type: "view", id: o.tracked, box: view, viewport: viewportSize() });
}

// refresh: every mark is read again from its element (or its page coordinates) and put there. An overlay that was removed
// is never touched again, whatever was waiting on it.
function refresh(o: Overlay): void {
    if (o.dead || overlay !== o) {
        return;
    }
    ensureAttached(o);
    const origin = originOf(o);
    const cache = new Map<string, Box>();
    const env = {
        elementBox: (selector: string) => {
            if (!cache.has(selector)) {
                cache.set(selector, elementBoxOf(selector));
            }
            return cache.get(selector);
        },
    };
    const missing: number[] = [];
    for (const mark of o.marks) {
        const { box, onElement } = resolveAnchor(mark.anchor, env);
        if (!onElement && mark.anchor.selector !== "") {
            missing.push(mark.id);
        }
        o.boxes.set(mark.id, box);
        const node = o.nodes.get(mark.id);
        if (node != null) {
            placeNode(node, box, origin);
        }
    }
    o.missing = new Set(missing);
    const key = missing.join(",");
    if (key !== o.missingKey) {
        o.missingKey = key;
        post({ type: "found", missing });
    }
    reportView(o);
}

// schedule: a refresh on the next frame, at most once in MinRefreshMs unless the marks are on something that moves with
// the viewport, which a scroll must follow frame by frame.
function schedule(o: Overlay, now = false): void {
    if (o.dead || o.frame !== 0 || o.timer !== 0) {
        return;
    }
    const wait = now ? 0 : Math.max(0, MinRefreshMs - (performance.now() - o.lastRun));
    if (wait > 0) {
        o.timer = window.setTimeout(() => {
            o.timer = 0;
            schedule(o, true);
        }, wait);
        return;
    }
    o.frame = requestAnimationFrame(() => {
        o.frame = 0;
        o.lastRun = performance.now();
        refresh(o);
    });
}

function setMarks(o: Overlay, marks: MarkView[]): void {
    if (o.dead) {
        return;
    }
    o.marks = marks;
    o.sticky = marks.some((m) => m.anchor.sticky === true);
    o.layer.replaceChildren();
    o.nodes.clear();
    o.boxes.clear();
    for (const mark of marks) {
        const node = buildMarkNode(mark);
        o.nodes.set(mark.id, node);
        o.layer.appendChild(node);
    }
    refresh(o);
}

function blockWheel(e: Event): void {
    e.preventDefault();
}

function applyLook(o: Overlay): void {
    o.host.style.setProperty("--c", o.color);
    o.capture.style.cursor = o.locked ? "progress" : o.tool === "point" ? "pointer" : "crosshair";
    o.capture.classList.toggle("paused", o.paused && !o.locked);
    o.capture.classList.toggle("locked", o.locked);
}

// lock: while the pictures are taken the capture layer stays over the page and takes every pointer and wheel, so the
// developer cannot scroll or click the page under a capture.
function lock(o: Overlay, locked: boolean): void {
    if (o.dead || o.locked === locked) {
        return;
    }
    o.locked = locked;
    o.drag = null;
    o.draft.style.display = "none";
    o.hover.style.display = "none";
    o.unlockWheel();
    if (locked) {
        o.capture.addEventListener("wheel", blockWheel, { passive: false });
        o.unlockWheel = () => {
            o.capture.removeEventListener("wheel", blockWheel);
            o.unlockWheel = () => {};
        };
    }
    applyLook(o);
}

// hide: the marks, the hover and the draft go out of sight for a picture; the capture layer stays, transparent.
function hide(o: Overlay, hidden: boolean): void {
    o.layer.style.visibility = hidden ? "hidden" : "visible";
}

// elementAt: the page element under a viewport point, never the overlay itself nor the document's root.
function elementAt(x: number, y: number, o: Overlay): Element {
    for (const el of document.elementsFromPoint(x, y)) {
        if (el === o.host || el === document.documentElement) {
            continue;
        }
        return el;
    }
    return null;
}

function bigElement(el: Element): boolean {
    if (el === document.body) {
        return true;
    }
    const rect = el.getBoundingClientRect();
    return rect.width * rect.height > window.innerWidth * window.innerHeight * BigElement;
}

function updateHover(o: Overlay, clientX: number, clientY: number): void {
    const el = o.tool === "point" && !o.paused && o.drag == null ? elementAt(clientX, clientY, o) : null;
    if (el == null || bigElement(el)) {
        o.hover.style.display = "none";
        return;
    }
    const box = pageBoxOf(el.getBoundingClientRect());
    const origin = originOf(o);
    o.hover.style.display = "block";
    placeNode(o.hover, box, origin);
}

function pageOf(e: PointerEvent): Point {
    const s = scrolledTo();
    return { x: e.clientX + s.x, y: e.clientY + s.y };
}

function marksHit(o: Overlay, p: Point): { id: number; box: Box } {
    return hitMark(
        o.marks.map((m) => ({ id: m.id, box: o.boxes.get(m.id) ?? m.anchor.box })),
        p
    );
}

function drawDraft(o: Overlay, tool: MarkKind, drag: Drag, now: Point): void {
    o.draft.replaceChildren();
    const origin = originOf(o);
    o.draft.className = "draft";
    if (tool === "zone") {
        const box = {
            x: Math.min(drag.down.x, now.x),
            y: Math.min(drag.down.y, now.y),
            w: Math.abs(now.x - drag.down.x),
            h: Math.abs(now.y - drag.down.y),
        };
        o.draft.className = "draft zone";
        o.draft.style.display = "block";
        placeNode(o.draft, box, origin);
        return;
    }
    if (tool === "freehand") {
        const bounds = boxOfPoints(drag.path);
        bounds.w = Math.max(1, bounds.w);
        bounds.h = Math.max(1, bounds.h);
        o.draft.style.display = "block";
        placeNode(o.draft, bounds, origin);
        o.draft.appendChild(polyline(pathFractions(drag.path, bounds)));
        return;
    }
    o.draft.style.display = "none";
}

// The element a mark is on: the one under a point; for a rectangle or an outline, the smallest one around the whole of
// it, the body at most.
function anchorElementFor(o: Overlay, kind: MarkKind, box: Box, up: Point): { el: Element; fixed: boolean; box: Box } {
    const s = scrolledTo();
    if (kind === "point") {
        const el = elementAt(up.x - s.x, up.y - s.y, o);
        if (el == null) {
            return { el: document.body, fixed: true, box };
        }
        if (bigElement(el)) {
            return { el, fixed: true, box };
        }
        return { el, fixed: false, box: pageBoxOf(el.getBoundingClientRect()) };
    }
    const cx = Math.min(window.innerWidth - 1, Math.max(0, box.x + box.w / 2 - s.x));
    const cy = Math.min(window.innerHeight - 1, Math.max(0, box.y + box.h / 2 - s.y));
    const stack = document.elementsFromPoint(cx, cy).filter((el) => el !== o.host && el !== document.documentElement);
    const at = pickAnchorIndex(
        stack.map((el) => pageBoxOf(el.getBoundingClientRect())),
        box
    );
    return { el: at >= 0 ? stack[at] : document.body, fixed: false, box };
}

function finishGesture(o: Overlay, drag: Drag, up: Point): void {
    const hit = marksHit(o, drag.down);
    const path = o.tool === "freehand" ? simplifyPath(drag.path) : [];
    const gesture = gestureOf(o.tool, drag.down, up, path, hit);
    if (gesture.kind === "edit") {
        post({ type: "edit", id: gesture.id });
        return;
    }
    if (gesture.kind !== "place") {
        return;
    }
    const target = anchorElementFor(o, gesture.mark, gesture.box, up);
    const box = target.box;
    const element =
        target.el != null
            ? { selector: selectorOf(target.el), box: pageBoxOf(target.el.getBoundingClientRect()) }
            : null;
    post({
        type: "placed",
        address: location.href,
        kind: gesture.mark,
        anchor: anchorOf(box, element, target.fixed, gesture.path, target.el != null && movesWithViewport(target.el)),
    });
}

function onPointerDown(o: Overlay, e: PointerEvent): void {
    if (!e.isTrusted || e.button !== 0 || o.paused || o.locked) {
        return;
    }
    e.preventDefault();
    try {
        o.capture.setPointerCapture(e.pointerId);
    } catch {
        // The pointer went already: the moves the layer gets still follow.
    }
    const p = pageOf(e);
    o.drag = { pointerId: e.pointerId, down: p, path: [p] };
    o.hover.style.display = "none";
    post({ type: "press" });
}

function onPointerMove(o: Overlay, e: PointerEvent): void {
    if (!e.isTrusted || o.locked) {
        return;
    }
    const drag = o.drag;
    if (drag == null) {
        updateHover(o, e.clientX, e.clientY);
        return;
    }
    const p = pageOf(e);
    const last = drag.path[drag.path.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= 2) {
        drag.path.push(p);
    }
    drawDraft(o, o.tool, drag, p);
}

function onPointerUp(o: Overlay, e: PointerEvent): void {
    const drag = o.drag;
    o.drag = null;
    o.draft.style.display = "none";
    if (drag == null || !e.isTrusted || e.pointerId !== drag.pointerId) {
        return;
    }
    finishGesture(o, drag, pageOf(e));
}

function listen(
    o: Overlay,
    target: EventTarget,
    type: string,
    fn: (e: any) => void,
    options?: AddEventListenerOptions
) {
    target.addEventListener(type, fn, options);
    o.removers.push(() => target.removeEventListener(type, fn, options));
}

function create(msg: StartMessage): Overlay {
    const host = document.createElement(HostTag);
    host.style.display = "block";
    host.style.position = "absolute";
    host.style.left = "0";
    host.style.top = "0";
    host.style.width = "0";
    host.style.height = "0";
    host.style.overflow = "visible";
    host.style.zIndex = "2147483647";
    host.style.pointerEvents = "none";
    const root = host.attachShadow({ mode: "closed" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(Css);
    root.adoptedStyleSheets = [sheet];
    const layer = document.createElement("div");
    layer.className = "layer";
    const hover = document.createElement("div");
    hover.className = "hover";
    hover.style.display = "none";
    const draft = document.createElement("div");
    draft.className = "draft";
    draft.style.display = "none";
    const capture = document.createElement("div");
    capture.className = "capture";
    layer.append(hover, draft);
    root.append(layer, capture);
    document.documentElement.appendChild(host);
    const o: Overlay = {
        host,
        root,
        layer,
        capture,
        hover,
        draft,
        color: msg.color,
        tool: msg.tool,
        paused: msg.paused,
        locked: false,
        dead: false,
        marks: [],
        nodes: new Map(),
        boxes: new Map(),
        missing: new Set(),
        missingKey: "",
        sticky: false,
        tracked: 0,
        lastView: "",
        saved: null,
        inner: new Map(),
        drag: null,
        frame: 0,
        timer: 0,
        lastRun: 0,
        flashTimer: 0,
        observer: null,
        mutations: null,
        removers: [],
        unlockWheel: () => {},
    };
    listen(o, capture, "pointerdown", (e) => onPointerDown(o, e));
    listen(o, capture, "pointermove", (e) => onPointerMove(o, e));
    listen(o, capture, "pointerup", (e) => onPointerUp(o, e));
    listen(o, capture, "pointercancel", () => {
        o.drag = null;
        o.draft.style.display = "none";
    });
    listen(o, capture, "pointerleave", () => {
        o.hover.style.display = "none";
    });
    listen(
        o,
        window,
        "scroll",
        (e) => {
            if (e.target !== document) {
                schedule(o);
            } else if (o.sticky) {
                schedule(o, true);
            } else {
                reportView(o);
            }
        },
        { capture: true, passive: true }
    );
    listen(o, window, "resize", () => schedule(o));
    listen(
        o,
        window,
        "keydown",
        (e: KeyboardEvent) => {
            if (!e.isTrusted) {
                return;
            }
            if (o.locked && ScrollKeys.has(e.key)) {
                // A page under a capture is not scrolled by a key either.
                e.preventDefault();
                return;
            }
            if (e.key !== "Escape" || (o.paused && !o.locked)) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            post({ type: "key", key: "Escape" });
        },
        { capture: true }
    );
    o.observer = new ResizeObserver(() => schedule(o));
    o.observer.observe(document.documentElement);
    // A script that moves an element is followed too; the overlay's own host is not a change of the page.
    o.mutations = new MutationObserver((records) => {
        if (records.some((r) => r.target !== o.host)) {
            schedule(o);
        }
    });
    o.mutations.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style", "hidden", "open"],
    });
    return o;
}

// destroy: no element, observer, listener or timer of the overlay is left, and what was waiting on it finds it dead.
function destroy(o: Overlay): void {
    o.dead = true;
    if (o.frame !== 0) {
        cancelAnimationFrame(o.frame);
        o.frame = 0;
    }
    window.clearTimeout(o.timer);
    window.clearTimeout(o.flashTimer);
    o.unlockWheel();
    o.observer?.disconnect();
    o.mutations?.disconnect();
    for (const remove of o.removers) {
        remove();
    }
    o.removers = [];
    o.host.remove();
}

function jump(to: { x: number; y: number }): void {
    window.scrollTo({ left: to.x, top: to.y, behavior: "instant" as ScrollBehavior });
}

// moveTo: the page scrolled to a place, waited for until it is there (a page may animate its scrolling, or hold it back
// while it loads more).
async function moveTo(o: Overlay, to: Point): Promise<void> {
    for (let i = 0; i < SettleTries && !o.dead; i++) {
        jump(to);
        await settle();
        if (Math.abs(window.scrollX - to.x) <= 1 && Math.abs(window.scrollY - to.y) <= 1) {
            return;
        }
    }
}

function failedPicture(reqId: number, reason: "gone" | "clipped"): FromGuest {
    return {
        type: "prepared",
        reqId,
        ok: false,
        viewport: viewportSize(),
        box: { x: 0, y: 0, w: 0, h: 0 },
        path: [],
        scroll: scrolledTo(),
        reason,
    };
}

// prepare: the marks out of sight, the mark's element and the page scrolled so that the mark is in view (the scrolling
// areas around the element too), and where the mark is said. A mark that a scrolling area of the page still clips has
// no picture.
async function prepare(o: Overlay, reqId: number, id: number): Promise<void> {
    o.saved = o.saved ?? scrolledTo();
    hide(o, true);
    refresh(o);
    const mark = o.marks.find((m) => m.id === id);
    const box = o.boxes.get(id);
    if (box == null || mark == null) {
        post(failedPicture(reqId, "gone"));
        return;
    }
    const el = mark.anchor.rel != null && !mark.anchor.sticky ? elementOf(mark.anchor.selector) : null;
    if (el != null) {
        saveInner(o, el);
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" as ScrollBehavior });
        await settle();
        if (o.dead) {
            return;
        }
        refresh(o);
    }
    await moveTo(o, scrollTarget(o.boxes.get(id) ?? box, viewportSize(), pageSize()));
    if (o.dead) {
        return;
    }
    refresh(o);
    const now = o.boxes.get(id) ?? box;
    const scroll = scrolledTo();
    const view = toViewport(now, scroll);
    if (el != null && visibleFraction(view, clipsOf(el)) < SeenAtLeast) {
        post(failedPicture(reqId, "clipped"));
        return;
    }
    const path: number[] =
        mark.kind === "freehand" ? pathPoints(mark.anchor.path, view).flatMap((p) => [p.x, p.y]) : [];
    post({
        type: "prepared",
        reqId,
        ok: true,
        viewport: viewportSize(),
        box: view,
        path,
        scroll,
        onElement: !o.missing.has(id),
    });
}

// The page scrolls as a whole, as a screenshot by screens needs: no inner scroller holds most of its height.
function scrollsAsWhole(): boolean {
    const view = window.innerHeight;
    if (pageSize().h > view + 1) {
        return true;
    }
    const roots: Element[] = [document.body, ...Array.from(document.body?.children ?? [])];
    for (const el of roots) {
        if (el == null) {
            continue;
        }
        const style = getComputedStyle(el);
        const scrolls = style.overflowY === "auto" || style.overflowY === "scroll";
        if (scrolls && el.scrollHeight > el.clientHeight + 8 && el.clientHeight > view * 0.6) {
            return false;
        }
    }
    return true;
}

async function overview(o: Overlay, reqId: number, slice: number): Promise<void> {
    o.saved = o.saved ?? scrolledTo();
    hide(o, true);
    if (slice >= 0) {
        const view = viewportSize();
        const doc = pageSize();
        const offset = Math.max(0, Math.min(slice * view.h, doc.h - view.h));
        await moveTo(o, { x: 0, y: offset });
        if (o.dead) {
            return;
        }
    } else {
        refresh(o);
    }
    const doc = pageSize();
    const view = viewportSize();
    post({
        type: "overview",
        reqId,
        ok: true,
        viewport: view,
        scroll: scrolledTo(),
        doc,
        whole: scrollsAsWhole() && doc.h <= view.h * MaxOverviewScreens,
        marks: o.marks.map((m) => ({
            id: m.id,
            n: m.n,
            kind: m.kind,
            box: o.boxes.get(m.id) ?? m.anchor.box,
            path:
                m.kind === "freehand"
                    ? pathPoints(m.anchor.path, o.boxes.get(m.id) ?? m.anchor.box).flatMap((p) => [p.x, p.y])
                    : [],
        })),
    });
}

async function restore(o: Overlay, reqId: number): Promise<void> {
    restoreInner(o);
    if (o.saved != null) {
        const at = o.saved;
        await moveTo(o, at);
        if (o.dead) {
            return;
        }
        o.saved = null;
    }
    hide(o, false);
    refresh(o);
    post({ type: "restored", reqId });
}

async function reveal(o: Overlay, id: number): Promise<void> {
    refresh(o);
    const box = o.boxes.get(id);
    const node = o.nodes.get(id);
    if (box == null || node == null) {
        return;
    }
    const mark = o.marks.find((m) => m.id === id);
    const el = mark != null && mark.anchor.rel != null && !mark.anchor.sticky ? elementOf(mark.anchor.selector) : null;
    if (el != null) {
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" as ScrollBehavior });
        await settle();
        if (o.dead) {
            return;
        }
        refresh(o);
    }
    await moveTo(o, scrollTarget(o.boxes.get(id) ?? box, viewportSize(), pageSize()));
    if (o.dead) {
        return;
    }
    refresh(o);
    node.classList.remove("flash");
    // Restarts the animation when the same mark is shown twice in a row.
    void node.getBoundingClientRect();
    node.classList.add("flash");
    window.clearTimeout(o.flashTimer);
    o.flashTimer = window.setTimeout(() => node.classList.remove("flash"), FlashMs);
}

// A request that reaches a page with no overlay (it was reloaded, or left) is answered at once as a failure, so the panel
// does not wait for its bound.
function answerWithoutOverlay(msg: ToGuest): void {
    if (msg.type === "prepare") {
        post(failedPicture(msg.reqId, "gone"));
    } else if (msg.type === "overview") {
        post({
            type: "overview",
            reqId: msg.reqId,
            ok: false,
            viewport: viewportSize(),
            scroll: scrolledTo(),
            doc: pageSize(),
            whole: false,
            marks: [],
        });
    } else if (msg.type === "restore") {
        post({ type: "restored", reqId: msg.reqId });
    }
}

function handle(msg: ToGuest): void {
    if (msg == null || typeof msg !== "object") {
        return;
    }
    if (msg.type === "start") {
        if (overlay == null) {
            overlay = create(msg);
            // A key meant for the page (Enter, Space) must not reach the element that happens to have the focus while a tool
            // is on.
            const active = document.activeElement as HTMLElement;
            if (active != null && active !== document.body && active !== document.documentElement) {
                active.blur?.();
            }
        }
        overlay.color = msg.color;
        overlay.tool = msg.tool;
        overlay.paused = msg.paused;
        overlay.tracked = msg.track ?? 0;
        overlay.lastView = "";
        applyLook(overlay);
        setMarks(overlay, msg.marks ?? []);
        return;
    }
    const o = overlay;
    if (o == null) {
        answerWithoutOverlay(msg);
        return;
    }
    switch (msg.type) {
        case "stop":
            // The page is put back where the developer left it, whatever a capture was doing.
            restoreScroll(o);
            destroy(o);
            overlay = null;
            return;
        case "tool":
            o.tool = msg.tool;
            o.hover.style.display = "none";
            applyLook(o);
            return;
        case "pause":
            o.paused = msg.paused;
            o.drag = null;
            o.draft.style.display = "none";
            o.hover.style.display = "none";
            applyLook(o);
            return;
        case "lock":
            lock(o, msg.locked);
            return;
        case "marks":
            setMarks(o, msg.marks ?? []);
            return;
        case "track":
            o.tracked = msg.id;
            o.lastView = "";
            reportView(o);
            return;
        case "reveal":
            void reveal(o, msg.id);
            return;
        case "prepare":
            void prepare(o, msg.reqId, msg.id);
            return;
        case "overview":
            void overview(o, msg.reqId, msg.slice);
            return;
        case "restore":
            void restore(o, msg.reqId);
            return;
    }
}

// installAnnotateGuest: the one listener the page's preload keeps while the mode is off.
export function installAnnotateGuest(): void {
    ipcRenderer.on(AnnotateChannel, (_event, msg: ToGuest) => handle(msg));
}
