// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { AnchorPx, KnotPx, RopePx } from "../tether/tether-model";
import type { BrainstormGraph, BrainstormNode } from "./brainstorm-graph-model";
import {
    arrival,
    cameraGoal,
    corePulse,
    declutter,
    emberRise,
    fitDistance,
    FreeRect,
    freeRect,
    graphBounds,
    KindLooks,
    Loops,
    newestNode,
    OverviewAfterMs,
    plateLook,
    PlateMarginPx,
    ropeCurve,
    Ropes,
    ScreenBox,
    swayAngle,
    Vec3,
} from "./brainstorm-scene-model";

function node(id: string, pos: Vec3, from = ""): BrainstormNode {
    return { id, kind: from === "" ? "topic" : "idea", text: id, from, status: "open", turn: 1, at: 1, pos };
}

const graph: BrainstormGraph = {
    schema: 1,
    rev: 3,
    centre: "c",
    nodes: [
        node("c", [0, 0, 0]),
        node("a", [240, 20, 0], "c"),
        node("b", [-200, -60, 120], "c"),
        node("d", [380, 60, -80], "a"),
    ],
    links: [{ a: "a", b: "b", turn: 2 }],
};

// FR-BOSS-010 AC5 (#2246): the ropes are the app's tether, read from tether-model.ts.
describe("the ropes", () => {
    it("take the tether's sizes: a 2 px rope, its anchor and its knot, and a thinner cross-link", () => {
        expect(Ropes.rope).toBe(RopePx);
        expect(Ropes.anchor).toBe(AnchorPx);
        expect(Ropes.knot).toBe(KnotPx);
        expect(RopePx).toBe(2);
        expect(Ropes.cross).toBeLessThan(Ropes.rope);
    });

    it("sag a little in their middle and end exactly on their two nodes", () => {
        const a: Vec3 = [0, 0, 0];
        const b: Vec3 = [200, 0, 0];
        const curve = ropeCurve(a, b);
        expect(curve).toHaveLength(Ropes.segments + 1);
        expect(curve[0]).toEqual(a);
        expect(curve[curve.length - 1]).toEqual(b);
        const middle = curve[Ropes.segments / 2];
        expect(middle[1]).toBeCloseTo(-200 * Ropes.sag, 6);
        expect(middle[0]).toBeCloseTo(100, 6);
    });

    it("give every kind a look, hot metal for a proposal and brass for a decision", () => {
        for (const kind of [
            "topic",
            "question",
            "answer",
            "idea",
            "theme",
            "decision",
            "proposal",
            "conclusion",
        ] as const) {
            expect(KindLooks[kind]).toBeDefined();
        }
        expect(KindLooks.proposal.glow).toBeGreaterThan(KindLooks.idea.glow);
    });
});

// AC6: the camera follows the newest node, then shows the whole graph after about 5 s without talk.
describe("the camera", () => {
    const free: FreeRect = { left: 700, top: 0, width: 900, height: 1000 };

    it("follows the newest node while he talks", () => {
        const goal = cameraGoal(graph, 1000, free, 1000);
        expect(goal.mode).toBe("follow");
        expect(newestNode(graph).id).toBe("d");
        const bounds = graphBounds(graph);
        expect(goal.target[0]).toBeCloseTo(bounds.centre[0] + (380 - bounds.centre[0]) * 0.7, 6);
        expect(goal.distance).toBeLessThan(cameraGoal(graph, OverviewAfterMs, free, 1000).distance);
    });

    it("pulls back to the whole graph after the pause, far enough to hold every node in the free space", () => {
        const goal = cameraGoal(graph, OverviewAfterMs, free, 1000);
        expect(goal.mode).toBe("overview");
        const bounds = graphBounds(graph);
        for (const n of graph.nodes) {
            const d = Math.hypot(...([0, 1, 2].map((i) => n.pos[i] - bounds.centre[i]) as [number, number, number]));
            expect(d).toBeLessThanOrEqual(bounds.radius);
        }
        // At that distance the sphere's radius takes at most 95 % of half the free space's smaller side, less part of a
        // plate on each side.
        const pxPerUnit = 1000 / (2 * goal.distance * Math.tan((38 * Math.PI) / 360));
        expect(bounds.radius * pxPerUnit).toBeLessThanOrEqual(0.475 * (900 - 2 * PlateMarginPx.x) + 1e-6);
        const narrow: FreeRect = { left: 0, top: 600, width: 1000, height: 400 };
        expect(fitDistance(bounds.radius, narrow, 1000)).toBeGreaterThan(fitDistance(bounds.radius, free, 1000));
    });

    it("shows the core alone as an overview, not filling the space", () => {
        expect(cameraGoal({ ...graph, nodes: [graph.nodes[0]] }, 0, free, 1000).mode).toBe("overview");
        expect(cameraGoal(null, 0, free, 1000).mode).toBe("overview");
    });
});

// AC5: the plates make room for each other on screen, around the core, inside the free space.
describe("the plates making room", () => {
    const free: FreeRect = { left: 0, top: 0, width: 1000, height: 800 };

    function overlap(a: ScreenBox, b: ScreenBox): boolean {
        return Math.abs(a.x - b.x) < a.hw + b.hw && Math.abs(a.y - b.y) < a.hh + b.hh;
    }

    it("pushes overlapping plates apart and leaves the core where it is", () => {
        const boxes: ScreenBox[] = [
            { x: 500, y: 400, hw: 40, hh: 50, fixed: true },
            { x: 510, y: 405, hw: 90, hh: 22 },
            { x: 530, y: 410, hw: 90, hh: 22 },
            { x: 700, y: 300, hw: 90, hh: 22 },
            { x: 705, y: 310, hw: 90, hh: 22 },
        ];
        const offsets = declutter(boxes, free, 30);
        expect(offsets[0]).toEqual([0, 0]);
        const moved = boxes.map((b, i) => ({ ...b, x: b.x + offsets[i][0], y: b.y + offsets[i][1] }));
        for (let i = 0; i < moved.length; i++) {
            for (let j = i + 1; j < moved.length; j++) {
                expect(overlap(moved[i], moved[j]), `${i} and ${j}`).toBe(false);
            }
        }
        for (const b of moved.slice(1)) {
            expect(b.x - b.hw).toBeGreaterThanOrEqual(free.left);
            expect(b.x + b.hw).toBeLessThanOrEqual(free.left + free.width);
        }
    });

    it("leaves outside a plate the camera left outside the free space", () => {
        const boxes: ScreenBox[] = [{ x: -300, y: 400, hw: 80, hh: 20 }];
        expect(declutter(boxes, free)).toEqual([[0, 0]]);
    });

    it("moves nothing that has room", () => {
        const boxes: ScreenBox[] = [
            { x: 200, y: 200, hw: 80, hh: 20 },
            { x: 600, y: 600, hw: 80, hh: 20 },
        ];
        expect(declutter(boxes, free)).toEqual([
            [0, 0],
            [0, 0],
        ]);
    });
});

describe("the free space", () => {
    it("is right of Brokk's group in a wide window and under it in a narrow one", () => {
        const group: FreeRect = { left: 8, top: 8, width: 1000, height: 560 };
        expect(freeRect({ width: 2000, height: 1200 }, group)).toEqual({
            left: 1032,
            top: 0,
            width: 968,
            height: 1200,
        });
        expect(freeRect({ width: 1080, height: 1200 }, group)).toEqual({ left: 0, top: 592, width: 1080, height: 608 });
        expect(freeRect({ width: 800, height: 600 }, null)).toEqual({ left: 0, top: 0, width: 800, height: 600 });
    });
});

// AC6, AC18 (NFR-SHELL-027): each loop declares its still state; under reduced motion nothing turns and nothing moves.
describe("the loops and their still states", () => {
    it("stands the core at its rest glow", () => {
        expect(corePulse(0, true)).toBe(Loops.corePulse.still);
        expect(corePulse(1234, true)).toBe(Loops.corePulse.still);
        expect(corePulse(0, false)).not.toBe(corePulse(Loops.corePulse.periodMs / 4, false));
    });

    it("stands the embers where they are", () => {
        expect(emberRise(0, 0.2, true)).toBe(emberRise(99999, 0.2, true));
        expect(emberRise(0, 0.2, false)).not.toBe(emberRise(1000, 0.2, false));
    });

    it("turns nothing by itself, and otherwise only sways round the front", () => {
        expect(swayAngle(0, true)).toBe(0);
        expect(swayAngle(Loops.sway.periodMs / 4, true)).toBe(0);
        expect(swayAngle(Loops.sway.periodMs / 4, false)).toBeCloseTo(Loops.sway.amplitudeRad, 6);
        for (let ms = 0; ms < Loops.sway.periodMs; ms += 997) {
            expect(Math.abs(swayAngle(ms, false))).toBeLessThan(Math.PI / 4);
        }
    });

    it("fades a node in instead of growing it", () => {
        expect(arrival(0, true)).toEqual({ scale: 1, opacity: 0 });
        expect(arrival(Loops.arrival.fadeMs, true)).toEqual({ scale: 1, opacity: 1 });
        expect(arrival(0, false).scale).toBeLessThan(1);
        expect(arrival(Loops.arrival.ms, false)).toEqual({ scale: 1, opacity: 1 });
        // The mechanical settle: a little past its size on the way.
        const mid = [100, 200, 300, 400, 500].map((ms) => arrival(ms, false).scale);
        expect(Math.max(...mid)).toBeGreaterThan(1);
    });
});

describe("the plates' depth", () => {
    it("reads nearer plates larger and clearer", () => {
        const near = plateLook(400, 600);
        const far = plateLook(1400, 600);
        expect(near.scale).toBeGreaterThan(far.scale);
        expect(near.opacity).toBeGreaterThan(far.opacity);
        expect(far.opacity).toBeGreaterThanOrEqual(0.35);
    });
});
