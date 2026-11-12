// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
    CameraNav,
    cameraPosition,
    CameraTiltRad,
    CameraView,
    ClosestRadius,
    DragThresholdPx,
    dragStarted,
    drawsAgain,
    inView,
    InViewMarginPx,
    keepInView,
    KeyPanPx,
    KeyZoom,
    Lens,
    NudgeAfterMs,
    overviewView,
    panView,
    pressPans,
    projectPoint,
    readKey,
    readWheel,
    zoomRange,
    zoomView,
} from "./brainstorm-camera-model";
import type { BrainstormGraph, BrainstormNode } from "./brainstorm-graph-model";
import { CameraFov, cameraGoal, fitDistance, OverviewAfterMs, Vec3 } from "./brainstorm-scene-model";

// Synthetic graphs only (FR-BOSS-010 AC7a, AC7b, #2283): no developer brainstorm.
function node(id: string, pos: Vec3, from = ""): BrainstormNode {
    return { id, kind: from === "" ? "topic" : "idea", text: id, from, status: "open", turn: 1, at: 1, pos };
}

function graphOf(...nodes: BrainstormNode[]): BrainstormGraph {
    return { schema: 1, rev: nodes.length, centre: nodes[0]?.id ?? "", nodes, links: [] };
}

// A graph of 25 plates in a wide ring, larger than the window at a close view: the developer's case on the gold.
function ring(count: number, radius: number): BrainstormGraph {
    const nodes = [node("c", [0, 0, 0])];
    for (let i = 0; i < count - 1; i++) {
        const a = (i / (count - 1)) * Math.PI * 2;
        nodes.push(node(`n${i}`, [Math.cos(a) * radius, Math.sin(a) * radius * 0.6, Math.sin(a * 3) * 80], "c"));
    }
    return graphOf(...nodes);
}

const graph = ring(25, 900);

// A stage of 1400 × 900 with Brokk's column on the left: the free space is on the right.
const lens: Lens = { width: 1400, height: 900, free: { left: 420, top: 0, width: 980, height: 900 }, azimuth: 0.2 };
const centre = { x: 420 + 980 / 2, y: 450 };

const near = (a: number, b: number, digits = 6) => expect(a).toBeCloseTo(b, digits);

// The point of the target's plane shown at a point of the stage.
function underPointer(view: CameraView, at: { x: number; y: number }, l: Lens): Vec3 {
    const f = l.height / (2 * Math.tan((CameraFov * Math.PI) / 360));
    const k = view.distance / f;
    const ca = Math.cos(l.azimuth);
    const sa = Math.sin(l.azimuth);
    const st = Math.sin(CameraTiltRad);
    const ct = Math.cos(CameraTiltRad);
    const right: Vec3 = [ca, 0, -sa];
    const up: Vec3 = [-sa * st, ct, -ca * st];
    const ox = (at.x - (l.free.left + l.free.width / 2)) * k;
    const oy = (at.y - (l.free.top + l.free.height / 2)) * k;
    return [
        view.target[0] + right[0] * ox - up[0] * oy,
        view.target[1] + right[1] * ox - up[1] * oy,
        view.target[2] + right[2] * ox - up[2] * oy,
    ];
}

function anyInView(view: CameraView, g: BrainstormGraph, l: Lens, margin: number): boolean {
    return g.nodes.some((n) => inView(n.pos, view, l, margin));
}

describe("the camera's geometry is the scene's", () => {
    // The scene places its three.js camera with cameraPosition and lookAt, and centres the free space with a view
    // offset: the model's projection must land each node where three.js draws it.
    it("projects a node where three.js draws it, for any sway and free space", () => {
        for (const azimuth of [0, 0.2, -0.34]) {
            const l = { ...lens, azimuth };
            const view: CameraView = { target: [40, -20, 15], distance: 1500 };
            const camera = new THREE.PerspectiveCamera(CameraFov, l.width / l.height, 1, 20000);
            const position = cameraPosition(view, azimuth);
            camera.position.set(position[0], position[1], position[2]);
            camera.lookAt(new THREE.Vector3(...view.target));
            const cx = l.free.left + l.free.width / 2;
            const cy = l.free.top + l.free.height / 2;
            camera.setViewOffset(l.width, l.height, l.width / 2 - cx, l.height / 2 - cy, l.width, l.height);
            camera.updateProjectionMatrix();
            camera.updateMatrixWorld();
            for (const n of graph.nodes) {
                const p = new THREE.Vector3(...n.pos).project(camera);
                const mine = projectPoint(n.pos, view, l);
                near(mine.x, ((p.x + 1) / 2) * l.width, 3);
                near(mine.y, ((1 - p.y) / 2) * l.height, 3);
            }
        }
    });

    it("draws the target at the middle of the free space, the camera at its distance", () => {
        const view: CameraView = { target: [10, 20, 30], distance: 1200 };
        const p = projectPoint(view.target, view, lens);
        near(p.x, centre.x);
        near(p.y, centre.y);
        near(p.depth, 1200);
        const position = cameraPosition(view, lens.azimuth);
        near(Math.hypot(position[0] - 10, position[1] - 20, position[2] - 30), 1200);
    });
});

describe("pan (AC7a)", () => {
    it("moves the graph with the hand, on the screen's two axes", () => {
        const view = overviewView(graph, lens);
        const before = projectPoint(view.target, view, lens);
        const moved = panView(view, 120, -45, lens);
        const after = projectPoint(view.target, moved, lens);
        near(after.x - before.x, 120);
        near(after.y - before.y, -45);
        near(moved.distance, view.distance);
    });

    it("keeps every node's depth: a pan never zooms", () => {
        const view = overviewView(graph, lens);
        const moved = panView(view, 300, 200, lens);
        for (const n of graph.nodes) {
            near(projectPoint(n.pos, moved, lens).depth, projectPoint(n.pos, view, lens).depth, 4);
        }
    });
});

describe("zoom about a point (AC7a)", () => {
    it("keeps the point under the pointer where it was, as map and design tools do", () => {
        const view = overviewView(graph, lens);
        const range = zoomRange(graph, lens);
        for (const at of [
            { x: 600, y: 200 },
            { x: 1350, y: 820 },
            centre,
        ]) {
            const point = underPointer(view, at, lens);
            for (const factor of [1.6, 0.7]) {
                const zoomed = zoomView(view, factor, at, lens, range);
                near(zoomed.distance, view.distance / factor, 6);
                const p = projectPoint(point, zoomed, lens);
                near(p.x, at.x, 4);
                near(p.y, at.y, 4);
            }
        }
    });

    it("has a minimum and a maximum", () => {
        const range = zoomRange(graph, lens);
        const overview = overviewView(graph, lens).distance;
        expect(range.min).toBeCloseTo(fitDistance(ClosestRadius, lens.free, lens.height), 6);
        expect(range.min).toBeLessThan(overview);
        expect(range.max).toBeGreaterThan(overview);
        expect(range.max).toBeLessThan(20000);
        const nav = new CameraNav();
        for (let i = 0; i < 60; i++) {
            nav.zoomAt(nav.view ?? overviewView(graph, lens), 2, centre, graph, lens, 1000);
        }
        near(nav.view.distance, range.min);
        for (let i = 0; i < 60; i++) {
            nav.zoomAt(nav.view, 0.5, centre, graph, lens, 1000);
        }
        near(nav.view.distance, range.max);
    });
});

describe("bounds (AC7a): the graph is never lost off screen", () => {
    it("leaves a view with a node in the free space as it is", () => {
        const view = overviewView(graph, lens);
        expect(keepInView(view, graph.nodes.map((n) => n.pos), lens)).toEqual(view);
    });

    it("brings a node back inside the free space's edge after a pan far away, the graph still on the pan's side", () => {
        for (const [dx, dy] of [
            [50000, 0],
            [-50000, 0],
            [0, 50000],
            [0, -50000],
            [30000, -30000],
        ]) {
            const nav = new CameraNav();
            const start = overviewView(graph, lens);
            nav.pan(start, dx, dy, graph, lens, 1000);
            expect(anyInView(nav.view, graph, lens, InViewMarginPx - 0.5), `${dx}, ${dy}`).toBe(true);
            // Bounded, not recentred: the graph's middle stays off to the side the hand pushed it.
            const middle = projectPoint(start.target, nav.view, lens);
            const side = (v: number) => (v > 0.5 ? 1 : v < -0.5 ? -1 : 0);
            expect(side(middle.x - centre.x), `${dx}, ${dy}`).toBe(side(dx));
            expect(side(middle.y - centre.y), `${dx}, ${dy}`).toBe(side(dy));
        }
    });

    it("moves the view no more than needed: the nearest node rests on the margin", () => {
        const flat = graphOf(node("c", [0, 0, 0]), node("a", [400, 0, 0], "c"));
        const l: Lens = { ...lens, azimuth: 0 };
        const nav = new CameraNav();
        nav.pan(overviewView(flat, l), 40000, 0, flat, l, 1000);
        const xs = flat.nodes.map((n) => projectPoint(n.pos, nav.view, l).x);
        near(Math.min(...xs), l.free.left + l.free.width - InViewMarginPx, 4);
    });

    it("holds at the closest zoom too, and in a narrow free space", () => {
        const narrow: Lens = { width: 600, height: 900, free: { left: 0, top: 520, width: 600, height: 380 }, azimuth: 0 };
        for (const l of [lens, narrow]) {
            const nav = new CameraNav();
            nav.zoomStep(overviewView(graph, l), 100, graph, l, 1000);
            nav.pan(nav.view, -80000, 60000, graph, l, 1000);
            expect(anyInView(nav.view, graph, l, 0)).toBe(true);
        }
    });

    it("keeps the centre's place in view while the graph is empty", () => {
        const empty = graphOf();
        const nav = new CameraNav();
        nav.pan(overviewView(empty, lens), 90000, 0, empty, lens, 1000);
        expect(inView([0, 0, 0], nav.view, lens, 0)).toBe(true);
    });

    it("keeps holding when the free space narrows under a still view", () => {
        const nav = new CameraNav();
        nav.pan(overviewView(graph, lens), -2000, 0, graph, lens, 1000);
        const narrower: Lens = { ...lens, free: { left: 900, top: 0, width: 500, height: 900 } };
        const goal = nav.goal(graph, 0, narrower);
        expect(anyInView({ target: goal.target, distance: goal.distance }, graph, narrower, 0)).toBe(true);
    });
});

describe("who holds the camera (AC7b)", () => {
    it("is Brokk at first: the camera follows his newest plates, then the overview", () => {
        const nav = new CameraNav();
        expect(nav.holder).toBe("brokk");
        for (const quiet of [0, OverviewAfterMs]) {
            const goal = nav.goal(graph, quiet, lens);
            const brokk = cameraGoal(graph, quiet, lens.free, lens.height);
            expect(goal).toEqual({ ...brokk, glide: true });
        }
    });

    it("passes to the developer at the first pan, from where the camera shows: no jump", () => {
        const nav = new CameraNav();
        const shown: CameraView = { target: [12, -8, 4], distance: 1800 };
        nav.pan(shown, 0, 0, graph, lens, 1000);
        expect(nav.holder).toBe("developer");
        expect(nav.view).toEqual(shown);
        const goal = nav.goal(graph, 0, lens);
        expect(goal).toEqual({ mode: "free", target: shown.target, distance: shown.distance, glide: false });
    });

    it("stops following his new plates: a plate added and his talk leave the view where it is", () => {
        const nav = new CameraNav();
        nav.pan(overviewView(graph, lens), 150, 40, graph, lens, 1000);
        const held = nav.goal(graph, 0, lens);
        const grown = graphOf(...graph.nodes, node("late", [700, 300, 0], "n3"));
        for (const quiet of [0, 2000, OverviewAfterMs + 1]) {
            expect(nav.goal(grown, quiet, lens)).toEqual(held);
        }
    });

    it("gives the camera back to Brokk with Follow Brokk", () => {
        const nav = new CameraNav();
        nav.pan(overviewView(graph, lens), 150, 40, graph, lens, 1000);
        nav.follow(false);
        expect(nav.holder).toBe("brokk");
        expect(nav.view).toBeNull();
        expect(nav.goal(graph, 0, lens)).toEqual({ ...cameraGoal(graph, 0, lens.free, lens.height), glide: true });
        expect(nav.takeJump()).toBe(false);
    });

    it("recentres on the whole graph and keeps the camera the developer's", () => {
        const nav = new CameraNav();
        nav.pan(overviewView(graph, lens), 600, 300, graph, lens, 1000);
        nav.recentre(graph, lens, 2000, false);
        const goal = nav.goal(graph, 0, lens);
        const overview = cameraGoal(graph, OverviewAfterMs, lens.free, lens.height);
        expect(goal.mode).toBe("free");
        expect(goal.target).toEqual(overview.target);
        near(goal.distance, overview.distance);
        expect(goal.glide).toBe(true);
    });

    it("under reduced motion, Recentre and Follow Brokk change the view at once, with one cross-fade", () => {
        const nav = new CameraNav();
        nav.recentre(graph, lens, 1000, true);
        expect(nav.goal(graph, 0, lens).glide).toBe(false);
        expect(nav.takeJump()).toBe(true);
        expect(nav.takeJump()).toBe(false);
        nav.follow(true);
        expect(nav.takeJump()).toBe(true);
        expect(nav.takeJump()).toBe(false);
    });

    it("a pan during a Recentre's glide starts from where the camera shows", () => {
        const nav = new CameraNav();
        nav.recentre(graph, lens, 1000, false);
        const midway: CameraView = { target: [300, 50, 0], distance: 2500 };
        nav.pan(midway, 0, 0, graph, lens, 1100);
        expect(nav.view).toEqual(midway);
        expect(nav.goal(graph, 0, lens).glide).toBe(false);
    });
});

describe("the Follow Brokk chip's pulse (AC7b)", () => {
    const outside: Vec3 = [90000, 0, 0];

    function heldAt(t: number): { nav: CameraNav; view: CameraView } {
        const nav = new CameraNav();
        nav.pan(overviewView(graph, lens), 0, 0, graph, lens, t);
        return { nav, view: nav.view };
    }

    it("never pulses while Brokk holds the camera", () => {
        const nav = new CameraNav();
        expect(nav.plateAdded(outside, overviewView(graph, lens), lens, NudgeAfterMs * 3)).toBe(false);
    });

    it("pulses once for a plate out of view after about 20 s untouched, and the view stays", () => {
        const { nav, view } = heldAt(1000);
        expect(nav.plateAdded(outside, view, lens, 1000 + NudgeAfterMs - 1)).toBe(false);
        expect(nav.plateAdded(outside, view, lens, 1000 + NudgeAfterMs)).toBe(true);
        expect(nav.view).toEqual(view);
        expect(nav.plateAdded(outside, view, lens, 1000 + NudgeAfterMs * 2)).toBe(false);
    });

    it("never pulses for a plate in view", () => {
        const { nav, view } = heldAt(1000);
        expect(nav.plateAdded(view.target, view, lens, 1000 + NudgeAfterMs * 2)).toBe(false);
    });

    it("may pulse again after the developer touched the view, once more quiet has passed", () => {
        const { nav, view } = heldAt(1000);
        expect(nav.plateAdded(outside, view, lens, 1000 + NudgeAfterMs)).toBe(true);
        nav.pan(view, 0, 0, graph, lens, 50000);
        expect(nav.plateAdded(outside, nav.view, lens, 50000 + 1000)).toBe(false);
        expect(nav.plateAdded(outside, nav.view, lens, 50000 + NudgeAfterMs)).toBe(true);
    });
});

describe("drawing on demand (AC18)", () => {
    it("draws every frame while things move by themselves", () => {
        expect(drawsAgain(false, 10_000, 0)).toBe(true);
    });

    it("under reduced motion, draws only until the settle after the last ask", () => {
        expect(drawsAgain(true, 1000, 1450)).toBe(true);
        expect(drawsAgain(true, 1450, 1450)).toBe(false);
        expect(drawsAgain(true, 9000, 1450)).toBe(false);
    });
});

describe("reading the gestures", () => {
    const wheel = (over: Partial<Parameters<typeof readWheel>[0]>) =>
        readWheel({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...over }, 900);

    it("pans with a two-finger scroll or the wheel, the graph moving against the scroll", () => {
        expect(wheel({ deltaX: 12, deltaY: -30 })).toEqual({ kind: "pan", dx: -12, dy: 30 });
        expect(wheel({ deltaY: 3, deltaMode: 1 })).toMatchObject({ kind: "pan", dy: -48 });
        expect(wheel({ deltaY: 40, shiftKey: true })).toEqual({ kind: "pan", dx: -40, dy: 0 });
    });

    it("zooms with a pinch (Ctrl) or Ctrl/⌘ + scroll: in when the fingers open, a notch never a leap", () => {
        const pinchOut = wheel({ deltaY: -5, ctrlKey: true });
        const pinchIn = wheel({ deltaY: 5, ctrlKey: true });
        expect(pinchOut.kind).toBe("zoom");
        expect(pinchOut.kind === "zoom" && pinchOut.factor).toBeGreaterThan(1);
        expect(pinchIn.kind === "zoom" && pinchIn.factor).toBeLessThan(1);
        expect(wheel({ deltaY: -100, metaKey: true })).toEqual(wheel({ deltaY: -1000, metaKey: true }));
        const notch = wheel({ deltaY: -100, metaKey: true });
        expect(notch.kind === "zoom" && notch.factor).toBeLessThan(2);
    });

    it("reads + and − as a zoom, 0 as Recentre and the arrows as a pan", () => {
        const key = (k: string, shiftKey = false) =>
            readKey({ key: k, shiftKey, ctrlKey: false, metaKey: false, altKey: false });
        expect(key("+")).toEqual({ kind: "zoom", factor: KeyZoom });
        expect(key("=")).toEqual({ kind: "zoom", factor: KeyZoom });
        expect(key("-")).toEqual({ kind: "zoom", factor: 1 / KeyZoom });
        expect(key("0")).toEqual({ kind: "recentre" });
        expect(key("0", true)).toEqual({ kind: "recentre" });
        expect(key("ArrowLeft")).toEqual({ kind: "pan", dx: KeyPanPx, dy: 0 });
        expect(key("ArrowDown", true)).toEqual({ kind: "pan", dx: 0, dy: -KeyPanPx * 3 });
    });

    it("leaves Escape and every key with Ctrl, ⌘ or Alt to the app", () => {
        expect(readKey({ key: "Escape", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })).toBeNull();
        for (const mod of ["ctrlKey", "metaKey", "altKey"]) {
            for (const k of ["+", "-", "0", "ArrowUp"]) {
                expect(
                    readKey({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, [mod]: true })
                ).toBeNull();
            }
        }
    });

    it("pans from a press on the background only: a press on a plate is the plate's", () => {
        expect(pressPans(0, false)).toBe(true);
        expect(pressPans(1, false)).toBe(true);
        expect(pressPans(0, true)).toBe(false);
        expect(pressPans(2, false)).toBe(false);
    });

    it("tells a click from a drag", () => {
        expect(dragStarted(1, 2)).toBe(false);
        expect(dragStarted(DragThresholdPx, 0)).toBe(true);
    });
});
