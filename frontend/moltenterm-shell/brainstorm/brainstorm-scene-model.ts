// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The rules of the 3D scene of Brokk's thought (FR-BOSS-010 AC4 to AC6, AC17 to AC19, DS-BOSS-008, #2246), pure so that
// they are tested without a graphics card: the look of each kind of node, the ropes' sizes and sag, where the camera
// goes, and each loop with its still state for reduced motion. brainstorm-scene.ts draws with them.
//
// It comes with the scene, in its own chunk: nothing here is loaded before the mode first opens.

import { AnchorPx, KnotPx, RopePx } from "../tether/tether-model";
import type { BrainstormGraph, BrainstormNode, NodeKind } from "./brainstorm-graph-model";

// The ropes are the app's tether (FR-BOSS-009 AC65 to AC69): 2 px, an anchor at the parent, a knot at the child. A
// cross-link between related ideas is a thinner rope, dashed, with neither.
export const Ropes = {
    rope: RopePx,
    anchor: AnchorPx,
    knot: KnotPx,
    // The dark under-rope that lets a rope read over a bright plate or the core's glow.
    outline: RopePx + 1.6,
    cross: RopePx * 0.6,
    dash: 3,
    gap: 5,
    // The middle of a rope hangs this share of its length below the straight line.
    sag: 0.14,
    segments: 14,
} as const;

// The core: a sphere of molten metal of this radius, in the world's units (about pixels at the overview).
export const CoreRadius = 30;

// Forge colours (the suite's language: orange is action and heat, brass is what holds). Hot metal for what is proposed,
// brass for a decision, cold steel for a question: no pastel (FR-BOSS-010 AC17).
export type KindLook = { rope: string; edge: string; label: string; plate: string; glow: number };

export const KindLooks: Record<NodeKind, KindLook> = {
    topic: { rope: "#ff9a3c", edge: "#ff9a3c", label: "#ffe2bf", plate: "rgba(60, 30, 10, 0.95)", glow: 1 },
    question: { rope: "#5b7b90", edge: "#3d5566", label: "#8fb3cf", plate: "rgba(16, 24, 30, 0.92)", glow: 0 },
    answer: { rope: "#7a6448", edge: "#5a4a34", label: "#cfc7bc", plate: "rgba(26, 22, 17, 0.92)", glow: 0 },
    idea: { rope: "#b8873f", edge: "#8a6a3a", label: "#e0b06a", plate: "rgba(34, 26, 15, 0.92)", glow: 0 },
    theme: { rope: "#8f7a5a", edge: "#6b5a40", label: "#d6c3a0", plate: "rgba(30, 26, 20, 0.92)", glow: 0 },
    decision: { rope: "#c9a46a", edge: "#c9a46a", label: "#e8c27a", plate: "rgba(44, 37, 25, 0.95)", glow: 0.3 },
    proposal: { rope: "#ff7c0d", edge: "#ff7c0d", label: "#ffb27a", plate: "rgba(58, 26, 8, 0.95)", glow: 0.8 },
    conclusion: { rope: "#ff9a3c", edge: "#ff9a3c", label: "#ffd9a8", plate: "rgba(60, 30, 10, 0.95)", glow: 1 },
};

export const CrossLinkColor = "#ff7c0d";

// The dark of the under-rope and of a knot's middle (hot iron's soot), and the white a tinted mark is drawn in.
export const SceneColors = { soot: "#1a120a", white: "#ffffff" } as const;

export type Vec3 = [number, number, number];

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function distance(a: Vec3, b: Vec3): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// A rope from a to b: a quadratic curve whose middle hangs `sag` of its length below the straight line (world y up).
export function ropeCurve(a: Vec3, b: Vec3, segments: number = Ropes.segments, sag: number = Ropes.sag): Vec3[] {
    const mid = lerp(a, b, 0.5);
    const control: Vec3 = [mid[0], mid[1] - distance(a, b) * sag * 2, mid[2]];
    const points: Vec3[] = [];
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const u = 1 - t;
        points.push([
            u * u * a[0] + 2 * u * t * control[0] + t * t * b[0],
            u * u * a[1] + 2 * u * t * control[1] + t * t * b[1],
            u * u * a[2] + 2 * u * t * control[2] + t * t * b[2],
        ]);
    }
    return points;
}

// The newest node: the camera goes to it while he speaks (AC6).
export function newestNode(graph: BrainstormGraph): BrainstormNode {
    const nodes = graph?.nodes ?? [];
    return nodes.length === 0 ? null : nodes[nodes.length - 1];
}

// How long without talk before the camera pulls back to the whole graph (AC6: about 5 s).
export const OverviewAfterMs = 5000;

export type CameraGoal = {
    mode: "follow" | "overview";
    target: Vec3;
    distance: number;
};

export const CameraFov = 38;
const FollowDistance = 520;
const MinOverviewDistance = 620;

// The sphere that holds every node, the centre's at least.
export function graphBounds(graph: BrainstormGraph): { centre: Vec3; radius: number } {
    const nodes = graph?.nodes ?? [];
    if (nodes.length === 0) {
        return { centre: [0, 0, 0], radius: CoreRadius * 4 };
    }
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const n of nodes) {
        for (let i = 0; i < 3; i++) {
            min[i] = Math.min(min[i], n.pos[i]);
            max[i] = Math.max(max[i], n.pos[i]);
        }
    }
    const centre = lerp(min, max, 0.5);
    let radius = CoreRadius * 4;
    for (const n of nodes) {
        radius = Math.max(radius, distance(centre, n.pos as Vec3) + 90);
    }
    return { centre, radius };
}

// The camera's distance that shows a sphere of `radius` whole in a view of this aspect.
export function fitDistance(radius: number, aspect: number, fovDeg: number = CameraFov): number {
    const vertical = (fovDeg * Math.PI) / 180;
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * Math.max(0.2, aspect));
    const narrowest = Math.min(vertical, horizontal);
    return Math.max(MinOverviewDistance, (radius / Math.sin(narrowest / 2)) * 1.05);
}

// Where the camera wants to be: on the newest node and its branch while the talk goes on, on the whole graph after
// OverviewAfterMs without talk. The follow keeps a little of the graph's middle in view (the mockup's 85 %).
export function cameraGoal(graph: BrainstormGraph, quietMs: number, aspect: number): CameraGoal {
    const bounds = graphBounds(graph);
    const newest = newestNode(graph);
    if (newest == null || quietMs >= OverviewAfterMs || (graph?.nodes?.length ?? 0) <= 1) {
        return { mode: "overview", target: bounds.centre, distance: fitDistance(bounds.radius, aspect) };
    }
    return { mode: "follow", target: lerp(bounds.centre, newest.pos as Vec3, 0.85), distance: FollowDistance };
}

// The share of the way to its goal the camera covers in dtMs: a smooth ease, the same at any frame rate.
export function easeShare(dtMs: number, tauMs = 650): number {
    return 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
}

// The loops of the scene and their still states (AC18, NFR-SHELL-027): under reduced motion the core stands at its
// rest glow, the embers stand where they are, nothing turns by itself, and the camera changes view by a cross-fade.
export const Loops = {
    // The core breathes: its glow between 0.75 and 1, in 2.6 s (the mockup's).
    corePulse: { periodMs: 2600, still: 0.85 },
    // The embers rise through the scene in about 9 s.
    emberRise: { periodMs: 9000, still: 0.35 },
    // The scene turns slowly, faster at the overview (the mockup's 0.03 and 0.07 rad/s).
    turn: { followRadPerS: 0.03, overviewRadPerS: 0.07, still: 0 },
    // A node's arrival: it grows out of its parent in this time; a fade alone under reduced motion.
    arrival: { ms: 700, fadeMs: 150 },
    // The cross-fade that replaces a camera move under reduced motion.
    crossFade: { ms: 150 },
} as const;

export function corePulse(nowMs: number, still: boolean): number {
    if (still) {
        return Loops.corePulse.still;
    }
    const phase = (nowMs % Loops.corePulse.periodMs) / Loops.corePulse.periodMs;
    return 0.875 + 0.125 * Math.sin(phase * 2 * Math.PI);
}

// Where an ember is in its rise, from 0 (born) to 1 (gone), for an ember of this offset.
export function emberRise(nowMs: number, offset: number, still: boolean): number {
    if (still) {
        return (Loops.emberRise.still + offset) % 1;
    }
    return (nowMs / Loops.emberRise.periodMs + offset) % 1;
}

export function turnRate(mode: CameraGoal["mode"], still: boolean): number {
    if (still) {
        return Loops.turn.still;
    }
    return mode === "overview" ? Loops.turn.overviewRadPerS : Loops.turn.followRadPerS;
}

// A node's arrival, from 0 to 1: it grows (scale) and lights up (opacity); under reduced motion it only fades in.
export function arrival(ageMs: number, still: boolean): { scale: number; opacity: number } {
    if (still) {
        return { scale: 1, opacity: Math.min(1, Math.max(0, ageMs / Loops.arrival.fadeMs)) };
    }
    const t = Math.min(1, Math.max(0, ageMs / Loops.arrival.ms));
    // A mechanical settle: a little past its size, then back (the suite's overshoot, an ease-out-back).
    const back = 1.4;
    const u = t - 1;
    const eased = 1 + (back + 1) * u * u * u + back * u * u;
    return { scale: Math.max(0.2, eased), opacity: Math.min(1, t * 1.6) };
}

// How a plate reads at its depth: the nearer, the larger and the clearer (the mockup's depth cue). `depth` is the
// distance from the camera, `focus` the camera's distance to its target.
export function plateLook(depth: number, focus: number): { scale: number; opacity: number; blur: number } {
    const scale = Math.min(1.25, Math.max(0.55, focus / Math.max(1, depth)));
    const opacity = Math.min(1, Math.max(0.35, 1.25 - Math.max(0, depth - focus) / 900));
    return { scale, opacity, blur: opacity < 0.6 ? 0.8 : 0 };
}
