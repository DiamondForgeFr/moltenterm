// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The camera of Brokk's thought, by hand (FR-BOSS-010 AC7a, AC7b, AC18, DS-BOSS-008, #2283): who holds it, how the
// developer pans and zooms the graph, the bounds that keep it on screen, and when the Follow Brokk chip pulses. Pure,
// with no three.js, so that it is tested without a graphics card; brainstorm-scene.ts asks it where to look and the
// stage reads the gestures with it. The camera's turn by hand and the click that focuses a node (#2247) build on it.
//
// - Brokk holds the camera until the developer navigates: it follows his newest plates, then the overview
//   (cameraGoal). Once the developer pans, zooms or recentres, the view is the developer's and never moves by itself;
//   Follow Brokk gives it back.
// - A pan moves the view in the screen's plane, a zoom moves it toward a point of the screen and keeps that point under
//   the pointer, as map and design tools do. At least one node always stays in the free space, and the zoom has a
//   minimum and a maximum.
// - A Recentre glides to the overview; under reduced motion it and Follow Brokk change the view at once (the stage
//   cross-fades), and a pan or a zoom follows the hand with no easing.

import type { BrainstormGraph } from "./brainstorm-graph-model";
import { CameraFov, CameraGoal, cameraGoal, fitDistance, FreeRect, OverviewAfterMs, Vec3 } from "./brainstorm-scene-model";

// The camera looks down on the relief from this angle above the horizon.
export const CameraTiltRad = 0.28;

// The developer has not touched the view for this long: a plate Brokk adds out of view makes the chip pulse once.
export const NudgeAfterMs = 20000;

// The closest view frames a sphere of this radius (about the core and its first plates); the farthest frames the
// whole graph at a third of its overview, never past the camera's far plane.
export const ClosestRadius = 90;
const FarthestShare = 3;
const FarthestDistance = 12000;

// A node counts as in view this far inside the free space's edges (less in a narrow one).
export const InViewMarginPx = 48;

// The keys' steps: a zoom by this factor, a pan by this many pixels (three times with Shift).
export const KeyZoom = 1.25;
export const KeyPanPx = 80;

// The wheel's zoom: e^(−delta × ZoomPerPx), a mouse notch capped so that one notch is not a leap.
const ZoomPerPx = 0.008;
const ZoomDeltaCap = 60;
const LinePx = 16;

// A press moves this far before it is a pan: shorter, it is a click.
export const DragThresholdPx = 4;

// Under reduced motion the scene draws a frame only when asked, and for this long after (a node's fade, the plates
// making room).
export const StillSettleMs = 450;

export type CameraView = { target: Vec3; distance: number };

// What the camera sees with: the canvas, the free space the graph is centred in, and the sway's angle.
export type Lens = { width: number; height: number; free: FreeRect; azimuth: number };

export type Holder = "brokk" | "developer";

// free: the developer holds the camera.
export type CameraMode = CameraGoal["mode"] | "free";

export type NavGoal = { mode: CameraMode; target: Vec3; distance: number; glide: boolean };

export type ScreenPoint = { x: number; y: number };

function add(a: Vec3, b: Vec3, s = 1): Vec3 {
    return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}

function sub(a: Vec3, b: Vec3): Vec3 {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

function copyView(view: CameraView): CameraView {
    return { target: [view.target[0], view.target[1], view.target[2]], distance: view.distance };
}

// The camera's axes for the sway's angle: right and up on the screen, and back toward the camera (three.js's lookAt
// with the world's y up).
export function cameraBasis(azimuth: number, tilt: number = CameraTiltRad): { right: Vec3; up: Vec3; back: Vec3 } {
    const sa = Math.sin(azimuth);
    const ca = Math.cos(azimuth);
    const st = Math.sin(tilt);
    const ct = Math.cos(tilt);
    return {
        right: [ca, 0, -sa],
        up: [-sa * st, ct, -ca * st],
        back: [sa * ct, st, ca * ct],
    };
}

export function cameraPosition(view: CameraView, azimuth: number): Vec3 {
    return add(view.target, cameraBasis(azimuth).back, view.distance);
}

// Pixels per world unit at a depth of 1: the canvas's height spans the field of view.
function focalPx(height: number): number {
    return Math.max(1, height) / (2 * Math.tan((CameraFov * Math.PI) / 360));
}

function viewCentre(lens: Lens): ScreenPoint {
    return { x: lens.free.left + lens.free.width / 2, y: lens.free.top + lens.free.height / 2 };
}

// Where a point of the world falls on the stage, in pixels, and how deep it is: the view's target is drawn at the free
// space's middle (the scene's view offset).
export function projectPoint(point: Vec3, view: CameraView, lens: Lens): { x: number; y: number; depth: number } {
    const { right, up, back } = cameraBasis(lens.azimuth);
    const d = sub(point, view.target);
    const depth = view.distance - dot(d, back);
    const f = focalPx(lens.height) / Math.max(1e-6, depth);
    const c = viewCentre(lens);
    return { x: c.x + dot(d, right) * f, y: c.y - dot(d, up) * f, depth };
}

// The point lies in the free space, `margin` px inside its edges, and in front of the camera.
export function inView(point: Vec3, view: CameraView, lens: Lens, margin = 0): boolean {
    const p = projectPoint(point, view, lens);
    if (p.depth <= 1) {
        return false;
    }
    const f = lens.free;
    return (
        p.x >= f.left + margin &&
        p.x <= f.left + f.width - margin &&
        p.y >= f.top + margin &&
        p.y <= f.top + f.height - margin
    );
}

// The overview: the whole graph framed in the free space (what Recentre shows).
export function overviewView(graph: BrainstormGraph, lens: Lens): CameraView {
    const goal = cameraGoal(graph, OverviewAfterMs, lens.free, lens.height);
    return { target: goal.target, distance: goal.distance };
}

// How close and how far the developer may zoom, as camera distances.
export function zoomRange(graph: BrainstormGraph, lens: Lens): { min: number; max: number } {
    const min = fitDistance(ClosestRadius, lens.free, lens.height);
    const max = Math.min(FarthestDistance, Math.max(min * 2, overviewView(graph, lens).distance * FarthestShare));
    return { min, max: Math.max(min, max) };
}

// The view moved with the hand: the graph follows the pointer by (dx, dy) pixels on the screen.
export function panView(view: CameraView, dx: number, dy: number, lens: Lens): CameraView {
    const { right, up } = cameraBasis(lens.azimuth);
    const k = view.distance / focalPx(lens.height);
    return { target: add(add(view.target, right, -dx * k), up, dy * k), distance: view.distance };
}

// The view zoomed by `factor` (above 1: closer) about a point of the stage, which stays under the pointer: the point of
// the target's plane under it is the same before and after.
export function zoomView(
    view: CameraView,
    factor: number,
    at: ScreenPoint,
    lens: Lens,
    range: { min: number; max: number }
): CameraView {
    const distance = clamp(view.distance / Math.max(1e-6, factor), range.min, range.max);
    const { right, up } = cameraBasis(lens.azimuth);
    const c = viewCentre(lens);
    const ox = at.x - c.x;
    const oy = at.y - c.y;
    const shift = (view.distance - distance) / focalPx(lens.height);
    return { target: add(add(view.target, right, ox * shift), up, -oy * shift), distance };
}

// The bounds: the view shifted the least so that at least one node stays in the free space, InViewMarginPx inside its
// edges. A pan keeps every node's depth, so the shift is exact. With no node yet, the centre's place stands for one.
export function keepInView(view: CameraView, nodes: Vec3[], lens: Lens, margin: number = InViewMarginPx): CameraView {
    const points = nodes.length > 0 ? nodes : [[0, 0, 0] as Vec3];
    const { right, up, back } = cameraBasis(lens.azimuth);
    const focal = focalPx(lens.height);
    const hx = Math.max(1, lens.free.width / 2 - Math.min(margin, lens.free.width / 4));
    const hy = Math.max(1, lens.free.height / 2 - Math.min(margin, lens.free.height / 4));
    let best: { ex: number; ey: number; depth: number; cost: number } = null;
    for (const point of points) {
        const d = sub(point, view.target);
        const depth = view.distance - dot(d, back);
        if (depth <= 1) {
            continue;
        }
        const sx = (dot(d, right) * focal) / depth;
        const sy = (-dot(d, up) * focal) / depth;
        const ex = sx - clamp(sx, -hx, hx);
        const ey = sy - clamp(sy, -hy, hy);
        if (ex === 0 && ey === 0) {
            return view;
        }
        const cost = Math.hypot(ex, ey);
        if (best == null || cost < best.cost) {
            best = { ex, ey, depth, cost };
        }
    }
    if (best == null) {
        return view;
    }
    const k = best.depth / focal;
    return { target: add(add(view.target, right, best.ex * k), up, -best.ey * k), distance: view.distance };
}

function bounded(view: CameraView, graph: BrainstormGraph, lens: Lens): CameraView {
    const range = zoomRange(graph, lens);
    const distance = clamp(view.distance, range.min, range.max);
    const nodes = (graph?.nodes ?? []).map((n) => n.pos as Vec3);
    return keepInView({ target: view.target, distance }, nodes, lens);
}

// Who holds the camera, and the developer's view. One per stage: a new stage (another brainstorm) starts with Brokk.
export class CameraNav {
    holder: Holder = "brokk";
    // Where the camera goes while the developer holds it.
    view: CameraView = null;
    // A Recentre glides to its view; a pan or a zoom is already there.
    glide = false;
    // When the developer last moved the view.
    touchedAt = 0;
    // The chip pulsed in this quiet stretch: not again before the developer touches the view.
    pulsed = false;
    // A Recentre or a Follow Brokk under reduced motion: the stage cross-fades once.
    jump = false;

    // The developer takes the camera where it shows, so the view never jumps when the hand starts (a Recentre still
    // gliding stops where it is).
    private take(shown: CameraView, now: number): void {
        if (this.holder !== "developer" || this.view == null || this.glide) {
            this.view = copyView(shown);
        }
        this.holder = "developer";
        this.glide = false;
        this.touchedAt = now;
        this.pulsed = false;
    }

    pan(shown: CameraView, dx: number, dy: number, graph: BrainstormGraph, lens: Lens, now: number): void {
        this.take(shown, now);
        this.view = bounded(panView(this.view, dx, dy, lens), graph, lens);
    }

    zoomAt(
        shown: CameraView,
        factor: number,
        at: ScreenPoint,
        graph: BrainstormGraph,
        lens: Lens,
        now: number
    ): void {
        this.take(shown, now);
        this.view = bounded(zoomView(this.view, factor, at, lens, zoomRange(graph, lens)), graph, lens);
    }

    // A zoom with the keys: about the middle of the free space.
    zoomStep(shown: CameraView, factor: number, graph: BrainstormGraph, lens: Lens, now: number): void {
        this.zoomAt(shown, factor, viewCentre(lens), graph, lens, now);
    }

    // The whole graph framed, by the developer's hand: it stays there.
    recentre(graph: BrainstormGraph, lens: Lens, now: number, still: boolean): void {
        this.holder = "developer";
        this.view = overviewView(graph, lens);
        this.glide = !still;
        this.jump = still;
        this.touchedAt = now;
        this.pulsed = false;
    }

    // The camera goes back to Brokk: his newest plates or the overview, as if the developer had never taken it.
    follow(still: boolean): void {
        if (this.holder === "brokk") {
            return;
        }
        this.holder = "brokk";
        this.view = null;
        this.glide = false;
        this.jump = still;
        this.pulsed = false;
    }

    // Brokk added a plate at `pos`: true when the chip pulses (the developer holds the camera, has not touched it for
    // NudgeAfterMs, the plate is out of view, and it has not pulsed in this quiet stretch). The view never moves.
    plateAdded(pos: Vec3, shown: CameraView, lens: Lens, now: number): boolean {
        if (this.holder !== "developer" || this.pulsed || now - this.touchedAt < NudgeAfterMs) {
            return false;
        }
        if (inView(pos, shown, lens)) {
            return false;
        }
        this.pulsed = true;
        return true;
    }

    // Where the camera goes this frame. Brokk's goal follows the talk; the developer's stays where it was put, kept in
    // its bounds (the free space narrows when his conversation window grows).
    goal(graph: BrainstormGraph, quietMs: number, lens: Lens): NavGoal {
        if (this.holder === "brokk" || this.view == null) {
            return { ...cameraGoal(graph, quietMs, lens.free, lens.height), glide: true };
        }
        if (!this.glide) {
            this.view = bounded(this.view, graph, lens);
        }
        return { mode: "free", target: this.view.target, distance: this.view.distance, glide: this.glide };
    }

    // Read once by the frame: a Recentre or a Follow Brokk under reduced motion asks for one cross-fade.
    takeJump(): boolean {
        const jump = this.jump;
        this.jump = false;
        return jump;
    }
}

// The scene keeps drawing: always while things move by themselves, and under reduced motion only until the settle after
// the last ask (never in a loop while idle).
export function drawsAgain(still: boolean, now: number, awakeUntil: number): boolean {
    return !still || now < awakeUntil;
}

export type WheelInput = {
    deltaX: number;
    deltaY: number;
    deltaMode: number;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
};

export type NavAction =
    | { kind: "pan"; dx: number; dy: number }
    | { kind: "zoom"; factor: number }
    | { kind: "recentre" };

// A wheel event: a pinch (the trackpad sends it with Ctrl) or Ctrl/⌘ + scroll zooms; a two-finger scroll or the mouse
// wheel pans (Shift turns a vertical wheel into a horizontal pan).
export function readWheel(input: WheelInput, pageHeight: number): NavAction {
    const unit = input.deltaMode === 1 ? LinePx : input.deltaMode === 2 ? Math.max(1, pageHeight) : 1;
    const dx = input.deltaX * unit;
    const dy = input.deltaY * unit;
    if (input.ctrlKey || input.metaKey) {
        return { kind: "zoom", factor: Math.exp(-clamp(dy, -ZoomDeltaCap, ZoomDeltaCap) * ZoomPerPx) };
    }
    if (input.shiftKey && dx === 0) {
        return { kind: "pan", dx: -dy, dy: 0 };
    }
    return { kind: "pan", dx: -dx, dy: -dy };
}

export type KeyInput = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };

// A key while the graph has the focus: + and − zoom, 0 recentres, the arrows pan. A key with Ctrl, ⌘ or Alt is the app's
// (its zoom and its shortcuts), and Escape keeps its meaning: neither is read here.
export function readKey(input: KeyInput): NavAction {
    if (input.ctrlKey || input.metaKey || input.altKey) {
        return null;
    }
    const step = KeyPanPx * (input.shiftKey ? 3 : 1);
    switch (input.key) {
        case "+":
        case "=":
            return { kind: "zoom", factor: KeyZoom };
        case "-":
        case "_":
        case "−":
            return { kind: "zoom", factor: 1 / KeyZoom };
        case "0":
            return { kind: "recentre" };
        case "ArrowLeft":
            return { kind: "pan", dx: step, dy: 0 };
        case "ArrowRight":
            return { kind: "pan", dx: -step, dy: 0 };
        case "ArrowUp":
            return { kind: "pan", dx: 0, dy: step };
        case "ArrowDown":
            return { kind: "pan", dx: 0, dy: -step };
        default:
            return null;
    }
}

// A press that may become a pan: the main button (or the middle one) on the background. A press on a plate is the
// plate's (a click, or its drag in #2247), never a pan.
export function pressPans(button: number, onPlate: boolean): boolean {
    return !onPlate && (button === 0 || button === 1);
}

// The press has moved far enough to be a pan, not a click.
export function dragStarted(dx: number, dy: number): boolean {
    return Math.hypot(dx, dy) >= DragThresholdPx;
}
