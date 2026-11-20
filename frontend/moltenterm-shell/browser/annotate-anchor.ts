// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Where a comment is on the live page (FR-BRW-017 AC25, #2422): its anchor, the CSS selector of the element under it,
// the geometry of the gestures that place it and of the captures taken at send time. Pure: the page's overlay
// (emain/moltenterm-annotate-guest.ts) and the panel's layer both import it, and a test runs it on fake elements.

import { type Anchor, type Box, MaxPathPoints, MinMarkPx, type MarkKind, type Point, PointMarkPx, type Size } from "./annotate-wire";

export function boxContains(outer: Box, inner: Box, tolerance = 1): boolean {
    return (
        inner.x >= outer.x - tolerance &&
        inner.y >= outer.y - tolerance &&
        inner.x + inner.w <= outer.x + outer.w + tolerance &&
        inner.y + inner.h <= outer.y + outer.h + tolerance
    );
}

export function boxHas(box: Box, p: Point, tolerance = 0): boolean {
    return (
        p.x >= box.x - tolerance &&
        p.x <= box.x + box.w + tolerance &&
        p.y >= box.y - tolerance &&
        p.y <= box.y + box.h + tolerance
    );
}

export function boxOfPoints(points: Point[]): Box {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const p of points) {
        x1 = Math.min(x1, p.x);
        y1 = Math.min(y1, p.y);
        x2 = Math.max(x2, p.x);
        y2 = Math.max(y2, p.y);
    }
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// dragBox: the rectangle two page points make, or null for a click (a drag too short in either direction).
export function dragBox(a: Point, b: Point): Box {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(a.x - b.x);
    const h = Math.abs(a.y - b.y);
    return w < MinMarkPx || h < MinMarkPx ? null : { x, y, w, h };
}

// A point marker: PointMarkPx square on the click, kept inside the page's left and top edges.
export function pointBox(at: Point): Box {
    return { x: Math.max(0, at.x - PointMarkPx / 2), y: Math.max(0, at.y - PointMarkPx / 2), w: PointMarkPx, h: PointMarkPx };
}

// What a press and a release do, points in page coordinates. hit: the mark under the press, if any. A click on a mark
// edits it, whatever the tool; a click with the point tool places a marker; a drag with the zone tool places a
// rectangle, with the freehand tool an outline (its points are all the points the pointer went through).
export type Gesture =
    | { kind: "place"; mark: MarkKind; box: Box; path: Point[] }
    | { kind: "edit"; id: number }
    | { kind: "none" };

export function gestureOf(
    tool: MarkKind,
    down: Point,
    up: Point,
    path: Point[],
    hit: { id: number; box: Box }
): Gesture {
    const moved = Math.max(Math.abs(up.x - down.x), Math.abs(up.y - down.y));
    if (tool === "zone") {
        const box = dragBox(down, up);
        if (box != null) {
            return { kind: "place", mark: "zone", box, path: [] };
        }
    }
    if (tool === "freehand" && path.length > 1) {
        const box = boxOfPoints(path);
        if (box.w >= MinMarkPx || box.h >= MinMarkPx) {
            const padded = { x: box.x, y: box.y, w: Math.max(box.w, MinMarkPx), h: Math.max(box.h, MinMarkPx) };
            return { kind: "place", mark: "freehand", box: padded, path };
        }
    }
    if (moved >= MinMarkPx) {
        return { kind: "none" };
    }
    if (hit != null) {
        return { kind: "edit", id: hit.id };
    }
    return tool === "point" ? { kind: "place", mark: "point", box: pointBox(up), path: [] } : { kind: "none" };
}

// hitMark: the mark under a page point; of several, the smallest, so one drawn inside another is the one a click
// reaches. A small tolerance keeps a thin outline within reach.
export function hitMark(marks: { id: number; box: Box }[], p: Point, tolerance = 4): { id: number; box: Box } {
    let found: { id: number; box: Box } = null;
    for (const m of marks) {
        if (!boxHas(m.box, p, tolerance)) {
            continue;
        }
        if (found == null || m.box.w * m.box.h < found.box.w * found.box.h) {
            found = m;
        }
    }
    return found;
}

// simplifyPath: a freehand stroke reduced to at most MaxPathPoints points, the corners kept (Ramer-Douglas-Peucker,
// the tolerance raised until the stroke fits).
export function simplifyPath(points: Point[], max = MaxPathPoints): Point[] {
    if (points.length <= 2) {
        return points.slice();
    }
    let tolerance = 1;
    let out = rdp(points, tolerance);
    while (out.length > max && tolerance < 64) {
        tolerance *= 1.6;
        out = rdp(points, tolerance);
    }
    return out.length > max ? out.slice(0, max) : out;
}

function rdp(points: Point[], tolerance: number): Point[] {
    const keep = new Array<boolean>(points.length).fill(false);
    keep[0] = true;
    keep[points.length - 1] = true;
    const stack: [number, number][] = [[0, points.length - 1]];
    while (stack.length > 0) {
        const [first, last] = stack.pop();
        let far = -1;
        let farDist = tolerance;
        for (let i = first + 1; i < last; i++) {
            const d = distanceToSegment(points[i], points[first], points[last]);
            if (d > farDist) {
                far = i;
                farDist = d;
            }
        }
        if (far >= 0) {
            keep[far] = true;
            stack.push([first, far], [far, last]);
        }
    }
    return points.filter((_, i) => keep[i]);
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) {
        return Math.hypot(p.x - a.x, p.y - a.y);
    }
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// pathFractions: points as fractions of their box (a box with no width or height counts as 1).
export function pathFractions(points: Point[], box: Box): number[] {
    const w = box.w > 0 ? box.w : 1;
    const h = box.h > 0 ? box.h : 1;
    const out: number[] = [];
    for (const p of points) {
        out.push((p.x - box.x) / w, (p.y - box.y) / h);
    }
    return out;
}

export function pathPoints(path: number[], box: Box): Point[] {
    const out: Point[] = [];
    for (let i = 0; i + 1 < (path?.length ?? 0); i += 2) {
        out.push({ x: box.x + path[i] * box.w, y: box.y + path[i + 1] * box.h });
    }
    return out;
}

// The element a mark was placed on, as the overlay found it: its selector and its box in page coordinates.
export type AnchorElement = { selector: string; box: Box };

// anchorOf: the anchor of a mark placed at box on element (null: no element could be named). fixed marks (a point
// marker) keep their size and are placed by their centre.
export function anchorOf(box: Box, element: AnchorElement, fixed: boolean, path: Point[]): Anchor {
    const el = element != null && element.selector !== "" && element.box.w > 0 && element.box.h > 0 ? element : null;
    let rel: Box = null;
    if (el != null) {
        rel = fixed
            ? {
                  x: (box.x + box.w / 2 - el.box.x) / el.box.w,
                  y: (box.y + box.h / 2 - el.box.y) / el.box.h,
                  w: 0,
                  h: 0,
              }
            : {
                  x: (box.x - el.box.x) / el.box.w,
                  y: (box.y - el.box.y) / el.box.h,
                  w: box.w / el.box.w,
                  h: box.h / el.box.h,
              };
    }
    return {
        box: { ...box },
        selector: el?.selector ?? "",
        rel,
        fixed,
        path: path.length > 1 ? pathFractions(path, box) : null,
    };
}

// What the page says now: the box of the element a selector names, or null when it names none that is drawn.
export type AnchorEnv = { elementBox(selector: string): Box };

// resolveAnchor: where a mark is now, in page coordinates. On its element when the selector still names one, so a
// page that was resized or reflowed carries the mark with it; else where it was placed.
export function resolveAnchor(anchor: Anchor, env: AnchorEnv): { box: Box; onElement: boolean } {
    if (anchor.selector !== "" && anchor.rel != null) {
        const el = env.elementBox(anchor.selector);
        if (el != null && el.w > 0 && el.h > 0) {
            if (anchor.fixed) {
                const cx = el.x + anchor.rel.x * el.w;
                const cy = el.y + anchor.rel.y * el.h;
                return {
                    box: { x: Math.max(0, cx - anchor.box.w / 2), y: Math.max(0, cy - anchor.box.h / 2), w: anchor.box.w, h: anchor.box.h },
                    onElement: true,
                };
            }
            return {
                box: {
                    x: el.x + anchor.rel.x * el.w,
                    y: el.y + anchor.rel.y * el.h,
                    w: anchor.rel.w * el.w,
                    h: anchor.rel.h * el.h,
                },
                onElement: true,
            };
        }
    }
    return { box: { ...anchor.box }, onElement: false };
}

// toViewport / fromViewport: a box between page coordinates and the viewport's, for a scroll position.
export function toViewport(box: Box, scroll: Point): Box {
    return { x: box.x - scroll.x, y: box.y - scroll.y, w: box.w, h: box.h };
}

export function fromViewport(box: Box, scroll: Point): Box {
    return { x: box.x + scroll.x, y: box.y + scroll.y, w: box.w, h: box.h };
}

const ViewMargin = 48;
const TallMark = 0.8;

// scrollTarget: where to scroll so a mark is in view for its capture: centred when it fits, else its top (and left)
// edge near the viewport's, within the page's scrollable extent.
export function scrollTarget(box: Box, viewport: Size, doc: Size): Point {
    const fit = (start: number, len: number, view: number, total: number) => {
        const max = Math.max(0, total - view);
        const wanted = len > view * TallMark ? start - ViewMargin : start + len / 2 - view / 2;
        return Math.min(max, Math.max(0, Math.round(wanted)));
    };
    return { x: fit(box.x, box.w, viewport.w, doc.w), y: fit(box.y, box.h, viewport.h, doc.h) };
}

// cropRegion: the part of the viewport a mark's capture holds: the mark with a margin around it, at least min, inside
// the viewport. A mark larger than the viewport gives the viewport.
export function cropRegion(box: Box, viewport: Size, pad: number, min: Size): Box {
    const w = Math.min(viewport.w, Math.max(min.w, box.w + 2 * pad));
    const h = Math.min(viewport.h, Math.max(min.h, box.h + 2 * pad));
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const x = Math.min(Math.max(0, cx - w / 2), viewport.w - w);
    const y = Math.min(Math.max(0, cy - h / 2), viewport.h - h);
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

// sliceOffsets: where the screens of a page start, top to bottom, the last one flush with the page's end; empty when
// the page is taller than max screens.
export function sliceOffsets(docH: number, viewH: number, max: number): number[] {
    if (!(viewH > 0) || !(docH > 0) || docH > viewH * max) {
        return [];
    }
    const count = Math.max(1, Math.ceil(docH / viewH - 0.001));
    const offsets: number[] = [];
    for (let i = 0; i < count; i++) {
        offsets.push(Math.max(0, Math.min(i * viewH, docH - viewH)));
    }
    return offsets;
}

// stableName: an id or a class that names a thing, not a build: no run of digits or hex that looks generated.
export function stableName(name: string): boolean {
    return /^[A-Za-z][\w-]{0,60}$/.test(name) && !/\d{4,}|[0-9a-f]{8,}|^(css|sc|jsx|emotion|svelte|astro|ember)-/i.test(name);
}

// What the selector builder reads of an element; the overlay fills it from the DOM, a test from a fake.
export type NodeFacts = {
    tag: string;
    id: string;
    testId: string;
    classes: string[];
    // The siblings of the same tag, this element included, and its place among them from 1.
    sameTag: number;
    indexOfTag: number;
    parent: NodeFacts;
};

const MaxSelectorDepth = 8;
const MaxSelectorChars = 300;

export function cssEscape(text: string): string {
    return text.replace(/[^\w-]/g, (c) => `\\${c}`);
}

function partOf(node: NodeFacts, escape: (s: string) => string): { text: string; anchored: boolean } {
    if (node.id !== "" && stableName(node.id)) {
        return { text: `#${escape(node.id)}`, anchored: true };
    }
    if (node.testId !== "") {
        return { text: `[data-testid="${node.testId.replace(/["\\]/g, "")}"]`, anchored: true };
    }
    const classes = node.classes.filter(stableName).slice(0, 2);
    let text = node.tag.toLowerCase() + classes.map((c) => `.${escape(c)}`).join("");
    if (node.sameTag > 1) {
        text += `:nth-of-type(${node.indexOfTag})`;
    }
    return { text, anchored: false };
}

// buildSelector: a CSS selector for an element, the shortest path of its own name and its ancestors' that names it
// alone in the document (unique says so): an id or a test id stops the climb. "" when none does within the depth.
export function buildSelector(node: NodeFacts, unique: (selector: string) => boolean, escape = cssEscape): string {
    const parts: string[] = [];
    let current = node;
    for (let depth = 0; current != null && depth < MaxSelectorDepth; depth++) {
        const part = partOf(current, escape);
        parts.unshift(part.text);
        const selector = parts.join(" > ");
        if (selector.length > MaxSelectorChars) {
            return "";
        }
        if (unique(selector)) {
            return selector;
        }
        if (part.anchored) {
            break;
        }
        current = current.parent;
    }
    return "";
}
