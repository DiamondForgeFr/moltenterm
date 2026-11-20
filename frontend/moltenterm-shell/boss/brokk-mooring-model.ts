// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's open group moored to the sidebar (FR-BOSS-009, AC107, AC108, #2421): the group stands 8 px right of the edge
// the sidebar is going to, not of where its slide is caught, and slides with it, in the sidebar's own time and curve, as
// a compositor transform. The thread from the face to the square follows; with the face out of the window it runs off
// the window's left edge. Pure, so the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { AjarPx, edgeFaceShiftPx, EdgeShape, EdgePx as StripPx } from "./brokk-edge-model";
import { GroupGeometry, GroupPlace, groupPlace } from "./brokk-group-model";

// The hidden sidebar waits this far past the window's left edge (sidebar.css, .mt-sb.is-hidden).
export const HiddenOverhangPx = 24;
// The inner margin of the floating sidebar (--mt-peek-inset, PeekInsetPx) when it cannot be read.
export const DefaultPeekInsetPx = 12;

export type ScreenRect = { left: number; top: number; width: number; height: number };

// What the sidebar's element says it is going to: hidden (floating), floated out (peek), and its strip for Brokk.
export type SidebarDraw = { hidden: boolean; peek: boolean; edge: EdgeShape };

// The sidebar's translateX once its slide has ended, as sidebar.css sets it (a test keeps the two equal). `width` is its
// own width (the -100%), `gap` the frame's margin (--mt-frame-gap).
export function sidebarLandingShiftPx(draw: SidebarDraw, width: number, gap: number): number {
    if (!draw.hidden) {
        return 0;
    }
    if (draw.edge === "peek") {
        return -width + StripPx - gap;
    }
    if (draw.edge === "ajar") {
        return -width + AjarPx - gap;
    }
    if (draw.edge === "rest" || !draw.peek) {
        return -width - HiddenOverhangPx;
    }
    return 0;
}

// The horizontal part of a computed transform: its scale and its translation, from `none`, `matrix()` or `matrix3d()`.
export function matrixXOf(transform: string): { scale: number; tx: number } {
    const text = (transform ?? "").trim();
    const m2 = /^matrix\(([^)]*)\)$/.exec(text);
    if (m2 != null) {
        const v = m2[1].split(",").map(Number);
        return { scale: Number.isFinite(v[0]) ? v[0] : 1, tx: Number.isFinite(v[4]) ? v[4] : 0 };
    }
    const m3 = /^matrix3d\(([^)]*)\)$/.exec(text);
    if (m3 != null) {
        const v = m3[1].split(",").map(Number);
        return { scale: Number.isFinite(v[0]) ? v[0] : 1, tx: Number.isFinite(v[12]) ? v[12] : 0 };
    }
    return { scale: 1, tx: 0 };
}

export type MooringInput = {
    // The host layer's box on screen, and the frame's margin inside it.
    layer: ScreenRect;
    inset: number;
    g: GroupGeometry;
    // The sidebar the group is moored to, as measured now (its slide's transform included), with the translateX it has
    // now and what it is going to; null with no sidebar to moor to.
    sidebar: { box: ScreenRect; shift: number; draw: SidebarDraw; gap: number };
    // The collapsed strip with no sidebar element: the group moors to the layer's left edge.
    edgeOnly?: boolean;
    // The title-bar face, as measured now, with its own translateX now, whether it is going to the strip, and the
    // sidebar's inner margin; null when no face is on screen.
    face: { box: ScreenRect; shift: number; edge: boolean; peekInset: number };
};

export type MooredFrame = {
    place: GroupPlace;
    origin: { x: number; y: number };
    thread: { x: number; y: number; w: number };
    // The layer's left edge on screen: it moves itself when the sidebar docks or undocks (the content's margin), so a
    // slide compares places on screen, not in the layer.
    layerX?: number;
};

// Where the group, the face it arrives from and the thread land, in the layer's coordinates: the boxes the slides are
// going to, so that a measure taken as the sidebar starts to move is right.
export function mooredFrame(input: MooringInput): MooredFrame {
    const { layer, inset, g, sidebar, face } = input;
    let sidebarRect: { x: number; y: number; w: number; h: number } = null;
    let sidebarShift = 0;
    let landingShift = 0;
    if (sidebar != null) {
        sidebarShift = sidebar.shift;
        landingShift = sidebarLandingShiftPx(sidebar.draw, sidebar.box.width, sidebar.gap);
        sidebarRect = {
            x: sidebar.box.left - sidebarShift + landingShift - layer.left,
            y: sidebar.box.top - layer.top,
            w: sidebar.box.width,
            h: sidebar.box.height,
        };
    } else if (input.edgeOnly) {
        sidebarRect = { x: 0, y: 0, w: 0, h: layer.height };
    }
    const place = groupPlace(sidebarRect, { width: layer.width, height: layer.height }, g, inset);
    if (face == null) {
        return { place, origin: null, thread: null, layerX: layer.left };
    }
    // The face rides with the sidebar it sits in, and moves on its own to the strip.
    const faceMove =
        sidebar == null
            ? 0
            : -sidebarShift + landingShift - face.shift + (face.edge ? edgeFaceShiftPx(face.peekInset) : 0);
    const faceLeft = face.box.left + faceMove - layer.left;
    const origin = { x: faceLeft + face.box.width / 2, y: face.box.top + face.box.height / 2 - layer.top };
    const faceRight = faceLeft + face.box.width;
    // The thread runs from the face to the square's edge, level with the face, kept inside the square's height. With the
    // face out of the window it starts there too, so it runs off the window's left edge.
    const thread =
        sidebarRect != null && place.left - faceRight > 0
            ? {
                  x: faceRight,
                  y: Math.min(Math.max(origin.y, place.top + 6), place.top + g.square - 6) - 1,
                  w: place.left - faceRight,
              }
            : null;
    return { place, origin, thread, layerX: layer.left };
}

// The sidebar's slide, to move with: the time left of its running transform transition and its curve.
export type Slide = { durationMs: number; easing: string };

export type TransitionFacts = {
    property: string;
    running: boolean;
    durationMs: number;
    elapsedMs: number;
    easing: string;
};

// A sidebar that changes without a slide (reduced motion, or docked again) moves the group without one.
export function slideOf(transitions: TransitionFacts[]): Slide {
    const slide = transitions.find((t) => t.property === "transform" && t.running);
    if (slide == null) {
        return null;
    }
    const left = Math.max(0, slide.durationMs - Math.max(0, slide.elapsedMs));
    if (left <= 0) {
        return null;
    }
    return { durationMs: left, easing: slide.easing || "linear" };
}

type Keyframes = { transform: string }[];

// Under a half pixel, nothing moves.
const StillPx = 0.5;

// The group's root plays from where it was seen to where it now stands (a FLIP): its children, the open panel and the
// conversation window among them, move with it.
export function groupSlideFrames(seenLeft: number, left: number): Keyframes {
    const dx = seenLeft - left;
    if (!Number.isFinite(dx) || Math.abs(dx) < StillPx) {
        return null;
    }
    return [{ transform: `translateX(${dx}px)` }, { transform: "translateX(0px)" }];
}

// The thread plays from the line that was seen to the new one, both ends at once: a translation and a stretch from its
// left end (brokk-group.css sets its transform-origin), so its right end stays on the square's edge at every frame.
export function threadSlideFrames(seen: { x: number; w: number }, line: { x: number; w: number }): Keyframes {
    if (seen == null || line == null || !(line.w > 0) || !(seen.w >= 0)) {
        return null;
    }
    const dx = seen.x - line.x;
    const scale = seen.w / line.w;
    if (Math.abs(dx) < StillPx && Math.abs(seen.w - line.w) < StillPx) {
        return null;
    }
    return [
        { transform: `translateX(${dx}px) scaleX(${Number(scale.toFixed(4))})` },
        { transform: "translateX(0px) scaleX(1)" },
    ];
}

export type SlidePlayed = { cancel: () => void };
type Animatable = { animate?: (keyframes: unknown, options: unknown) => SlidePlayed };

// Plays a slide on an element, with the sidebar's time and curve; nothing where the page cannot animate.
export function playSlide(element: Animatable, frames: Keyframes, slide: Slide): SlidePlayed {
    if (frames == null || slide == null || element?.animate == null) {
        return null;
    }
    return element.animate(frames, { duration: slide.durationMs, easing: slide.easing });
}

// Two measures that land the same: the group keeps its frame and draws nothing again.
export function sameMooredFrame(a: MooredFrame, b: MooredFrame): boolean {
    if (a == null || b == null) {
        return a === b;
    }
    const near = (x: number, y: number) => Math.abs(x - y) < StillPx;
    const samePoint = (p: { x: number; y: number }, q: { x: number; y: number }) =>
        p == null || q == null ? p === q : near(p.x, q.x) && near(p.y, q.y);
    const sameThread =
        a.thread == null || b.thread == null
            ? a.thread === b.thread
            : near(a.thread.x, b.thread.x) && near(a.thread.y, b.thread.y) && near(a.thread.w, b.thread.w);
    return (
        near(a.place.left, b.place.left) &&
        near(a.place.top, b.place.top) &&
        near(a.place.panelRoom, b.place.panelRoom) &&
        near(a.place.heightRoom, b.place.heightRoom) &&
        near(a.layerX ?? 0, b.layerX ?? 0) &&
        samePoint(a.origin, b.origin) &&
        sameThread
    );
}
