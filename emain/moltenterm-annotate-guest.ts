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
    boxContains,
    boxOfPoints,
    buildSelector,
    gestureOf,
    hitMark,
    type NodeFacts,
    pathFractions,
    pathPoints,
    resolveAnchor,
    scrollTarget,
    simplifyPath,
    toViewport,
} from "../frontend/moltenterm-shell/browser/annotate-anchor";
import {
    AnnotateChannel,
    type Box,
    type FromGuest,
    MaxOverviewScreens,
    type MarkKind,
    type MarkView,
    type Point,
    PointMarkPx,
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
    marks: MarkView[];
    nodes: Map<number, HTMLElement>;
    boxes: Map<number, Box>;
    tracked: number;
    lastView: string;
    // Where the developer had scrolled the page before a capture moved it.
    saved: Point;
    drag: Drag;
    frame: number;
    flashTimer: number;
    observer: ResizeObserver;
    removers: (() => void)[];
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
    if (!o.host.isConnected) {
        document.documentElement.appendChild(o.host);
    }
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

// refresh: every mark is read again from its element (or its page coordinates) and put there.
function refresh(o: Overlay): void {
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
    for (const mark of o.marks) {
        const { box } = resolveAnchor(mark.anchor, env);
        o.boxes.set(mark.id, box);
        const node = o.nodes.get(mark.id);
        if (node != null) {
            placeNode(node, box, origin);
        }
    }
    reportView(o);
}

function schedule(o: Overlay): void {
    if (o.frame !== 0) {
        return;
    }
    const run = () => {
        if (overlay !== o) {
            return;
        }
        o.frame = 0;
        refresh(o);
    };
    o.frame = requestAnimationFrame(run);
}

function setMarks(o: Overlay, marks: MarkView[]): void {
    o.marks = marks;
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

function applyLook(o: Overlay): void {
    o.host.style.setProperty("--c", o.color);
    o.capture.style.cursor = o.tool === "point" ? "pointer" : "crosshair";
    o.capture.classList.toggle("paused", o.paused);
}

function hide(o: Overlay, hidden: boolean): void {
    o.host.style.visibility = hidden ? "hidden" : "visible";
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
    let el = elementAt(cx, cy, o) ?? document.body;
    while (el != null && el !== document.body && !boxContains(pageBoxOf(el.getBoundingClientRect()), box, 2)) {
        el = el.parentElement;
    }
    return { el: el ?? document.body, fixed: false, box };
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
    const element = target.el != null ? { selector: selectorOf(target.el), box: pageBoxOf(target.el.getBoundingClientRect()) } : null;
    post({
        type: "placed",
        address: location.href,
        kind: gesture.mark,
        anchor: anchorOf(box, element, target.fixed, gesture.path),
    });
}

function onPointerDown(o: Overlay, e: PointerEvent): void {
    if (!e.isTrusted || e.button !== 0 || o.paused) {
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
    if (!e.isTrusted) {
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

function listen(o: Overlay, target: EventTarget, type: string, fn: (e: any) => void, options?: AddEventListenerOptions) {
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
        marks: [],
        nodes: new Map(),
        boxes: new Map(),
        tracked: 0,
        lastView: "",
        saved: null,
        drag: null,
        frame: 0,
        flashTimer: 0,
        observer: null,
        removers: [],
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
            if (e.target === document) {
                reportView(o);
            } else {
                schedule(o);
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
            if (!e.isTrusted || e.key !== "Escape" || o.paused) {
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
    return o;
}

function destroy(o: Overlay): void {
    if (o.frame !== 0) {
        cancelAnimationFrame(o.frame);
    }
    window.clearTimeout(o.flashTimer);
    o.observer?.disconnect();
    for (const remove of o.removers) {
        remove();
    }
    o.host.remove();
}

function jump(to: { x: number; y: number }): void {
    window.scrollTo({ left: to.x, top: to.y, behavior: "instant" as ScrollBehavior });
}

// moveTo: the page scrolled to a place, waited for until it is there (a page may animate its scrolling, or hold it back
// while it loads more).
async function moveTo(to: Point): Promise<void> {
    for (let i = 0; i < SettleTries; i++) {
        jump(to);
        await settle();
        if (Math.abs(window.scrollX - to.x) <= 1 && Math.abs(window.scrollY - to.y) <= 1) {
            return;
        }
    }
}

async function prepare(o: Overlay, reqId: number, id: number): Promise<void> {
    o.saved = o.saved ?? scrolledTo();
    hide(o, true);
    refresh(o);
    const box = o.boxes.get(id);
    const mark = o.marks.find((m) => m.id === id);
    if (box == null || mark == null) {
        post({ type: "prepared", reqId, ok: false, viewport: viewportSize(), box: { x: 0, y: 0, w: 0, h: 0 }, path: [], scroll: scrolledTo() });
        return;
    }
    await moveTo(scrollTarget(box, viewportSize(), pageSize()));
    refresh(o);
    const now = o.boxes.get(id) ?? box;
    const scroll = scrolledTo();
    const view = toViewport(now, scroll);
    const path: number[] =
        mark.kind === "freehand"
            ? pathPoints(mark.anchor.path, view).flatMap((p) => [p.x, p.y])
            : [];
    post({ type: "prepared", reqId, ok: true, viewport: viewportSize(), box: view, path, scroll });
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
        await moveTo({ x: 0, y: offset });
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
    if (o.saved != null) {
        await moveTo(o.saved);
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
    await moveTo(scrollTarget(box, viewportSize(), pageSize()));
    refresh(o);
    node.classList.remove("flash");
    // Restarts the animation when the same mark is shown twice in a row.
    void node.getBoundingClientRect();
    node.classList.add("flash");
    window.clearTimeout(o.flashTimer);
    o.flashTimer = window.setTimeout(() => node.classList.remove("flash"), FlashMs);
}

function handle(msg: ToGuest): void {
    if (msg == null || typeof msg !== "object") {
        return;
    }
    if (msg.type === "start") {
        if (overlay == null) {
            overlay = create(msg);
        }
        overlay.color = msg.color;
        overlay.tool = msg.tool;
        overlay.paused = msg.paused;
        applyLook(overlay);
        setMarks(overlay, msg.marks ?? []);
        return;
    }
    const o = overlay;
    if (o == null) {
        return;
    }
    switch (msg.type) {
        case "stop":
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
