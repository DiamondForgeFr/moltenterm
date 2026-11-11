// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { AnchorPx, KnotPx, RopePx } from "../tether/tether-model";
import type { BrainstormGraph, BrainstormNode } from "./brainstorm-graph-model";
import {
    arrival,
    cameraGoal,
    corePulse,
    emberRise,
    fitDistance,
    graphBounds,
    KindLooks,
    Loops,
    newestNode,
    OverviewAfterMs,
    plateLook,
    ropeCurve,
    Ropes,
    turnRate,
    Vec3,
} from "./brainstorm-scene-model";

function node(id: string, pos: Vec3, from = ""): BrainstormNode {
    return { id, kind: from === "" ? "topic" : "idea", text: id, from, status: "open", turn: 1, at: 1, pos };
}

const graph: BrainstormGraph = {
    schema: 1,
    rev: 3,
    centre: "c",
    nodes: [node("c", [0, 0, 0]), node("a", [240, 20, 0], "c"), node("b", [-200, -60, 120], "c"), node("d", [380, 60, -80], "a")],
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
        for (const kind of ["topic", "question", "answer", "idea", "theme", "decision", "proposal", "conclusion"] as const) {
            expect(KindLooks[kind]).toBeDefined();
        }
        expect(KindLooks.proposal.glow).toBeGreaterThan(KindLooks.idea.glow);
    });
});

// AC6: the camera follows the newest node, then shows the whole graph after about 5 s without talk.
describe("the camera", () => {
    it("follows the newest node while he talks", () => {
        const goal = cameraGoal(graph, 1000, 16 / 9);
        expect(goal.mode).toBe("follow");
        expect(newestNode(graph).id).toBe("d");
        const bounds = graphBounds(graph);
        expect(goal.target[0]).toBeCloseTo(bounds.centre[0] + (380 - bounds.centre[0]) * 0.85, 6);
    });

    it("pulls back to the whole graph after the pause, far enough to hold every node", () => {
        const goal = cameraGoal(graph, OverviewAfterMs, 16 / 9);
        expect(goal.mode).toBe("overview");
        const bounds = graphBounds(graph);
        for (const n of graph.nodes) {
            const d = Math.hypot(...([0, 1, 2].map((i) => n.pos[i] - bounds.centre[i]) as [number, number, number]));
            expect(d).toBeLessThanOrEqual(bounds.radius);
        }
        expect(goal.distance).toBeGreaterThanOrEqual(fitDistance(bounds.radius, 16 / 9) - 1e-6);
        expect(fitDistance(bounds.radius, 0.5)).toBeGreaterThan(fitDistance(bounds.radius, 2));
    });

    it("shows the core alone as an overview", () => {
        expect(cameraGoal({ ...graph, nodes: [graph.nodes[0]] }, 0, 1).mode).toBe("overview");
        expect(cameraGoal(null, 0, 1).mode).toBe("overview");
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

    it("turns nothing by itself", () => {
        expect(turnRate("overview", true)).toBe(0);
        expect(turnRate("follow", true)).toBe(0);
        expect(turnRate("overview", false)).toBeGreaterThan(turnRate("follow", false));
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
