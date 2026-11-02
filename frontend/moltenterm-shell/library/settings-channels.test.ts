// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import {
    AmbientFlow,
    ambientKeyframes,
    ambientTiming,
    ChannelLayout,
    channelNetwork,
    ChannelPx,
    channelRoutes,
    FrameGridPerSecond,
    networkPath,
    runLength,
    setAmbientMotion,
    simplifyRoute,
    snappedStart,
} from "./settings-channels";

// The Appearance block at 1900 px: three masonry columns of 565 px with a 32 px gap, the page's header above.
const masonry: ChannelLayout = {
    chip: { x: 223, y: 4, w: 101, h: 27 },
    page: { x: 0, y: 51, w: 1824, h: 654 },
    cards: [
        { x: 32, y: 167, w: 565, h: 197 },
        { x: 32, y: 396, w: 565, h: 285 },
        { x: 629, y: 167, w: 565, h: 513 },
        { x: 1227, y: 167, w: 565, h: 135 },
        { x: 1227, y: 334, w: 565, h: 192 },
    ],
};
// The page's header (title, description): no channel may cross it.
const header = { x: 32, y: 51, w: 1760, h: 84 };

function inside(p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }): boolean {
    return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
}

describe("settings channels: the routes (DS-SHELL-138, #1549)", () => {
    it("keeps a route's turns only", () => {
        expect(
            simplifyRoute([
                { x: 0, y: 0 },
                { x: 0, y: 0 },
                { x: 0, y: 5 },
                { x: 0, y: 10 },
                { x: 4, y: 10 },
            ])
        ).toEqual([
            { x: 0, y: 0 },
            { x: 0, y: 10 },
            { x: 4, y: 10 },
        ]);
    });

    it("runs at right angles from under the chip to the middle of each card's top edge", () => {
        const routes = channelRoutes(masonry);
        expect(routes).toHaveLength(5);
        routes.forEach((route, i) => {
            const card = masonry.cards[i];
            expect(route[0].x).toBe(Math.round(masonry.chip.x + masonry.chip.w / 2));
            expect(route[0].y).toBeLessThan(masonry.page.y);
            const end = route[route.length - 1];
            expect(end).toEqual({ x: Math.round(card.x + card.w / 2), y: card.y });
            for (let k = 0; k + 1 < route.length; k++) {
                const a = route[k];
                const b = route[k + 1];
                expect(a.x === b.x || a.y === b.y).toBe(true);
            }
            // never through the header, and into the card only by its top edge
            for (let k = 0; k + 1 < route.length; k++) {
                const a = route[k];
                const b = route[k + 1];
                for (let s = 0; s <= 20; s++) {
                    const p = { x: a.x + ((b.x - a.x) * s) / 20, y: a.y + ((b.y - a.y) * s) / 20 };
                    expect(inside(p, header)).toBe(false);
                    for (const c of masonry.cards) {
                        expect(inside(p, c)).toBe(false);
                    }
                }
            }
        });
    });

    it("goes down the left margin, then the column gutters, and along the gap above a lower card", () => {
        const routes = channelRoutes(masonry);
        const spine = routes[0][2].x;
        expect(spine).toBe(16);
        // a lower card of the first column: down the spine to the gap above it, 16 px over its top
        expect(routes[1]).toContainEqual({ x: spine, y: 396 - 16 });
        // a lower card of the third column: down the gutter between the columns, in the middle of the 32 px gap
        expect(routes[4]).toContainEqual({ x: 1227 - 16, y: 167 - 16 });
        expect(routes[4]).toContainEqual({ x: 1227 - 16, y: 334 - 16 });
    });

    it("ends in each card's icon tile and never runs under a tile (#1593)", () => {
        // The suite's tile: 36 px square, overhanging the card's top-left corner by 16 px.
        const tiles = masonry.cards.map((c) => ({ x: c.x - 16, y: c.y - 16, w: 36, h: 36 }));
        const routes = channelRoutes({ ...masonry, tiles });
        routes.forEach((route, i) => {
            const t = tiles[i];
            expect(route[route.length - 1]).toEqual({ x: t.x + t.w / 2, y: t.y });
            for (let k = 0; k + 1 < route.length; k++) {
                const a = route[k];
                const b = route[k + 1];
                expect(a.x === b.x || a.y === b.y).toBe(true);
                for (let s = 0; s <= 40; s++) {
                    const p = { x: a.x + ((b.x - a.x) * s) / 40, y: a.y + ((b.y - a.y) * s) / 40 };
                    expect(inside(p, header)).toBe(false);
                    masonry.cards.forEach((c, j) => {
                        expect(inside(p, c)).toBe(false);
                        // the groove (12 px) clears every tile but the one it ends in
                        if (j !== i) {
                            const half = ChannelPx.groove / 2;
                            const tj = tiles[j];
                            expect(
                                inside(p, { x: tj.x - half, y: tj.y - half, w: tj.w + 2 * half, h: tj.h + 2 * half })
                            ).toBe(false);
                        }
                    });
                }
            }
        });
        // the spine in the middle of the margin left of the tiles, the manifold 12 px above them
        expect(routes[0][2].x).toBe(8);
        expect(routes[0]).toContainEqual({ x: 8, y: 167 - 16 - ChannelPx.aboveTile });
        // a lower card: the lane in the middle of the 16 px left between the card above and the tile
        expect(routes[1]).toContainEqual({ x: 8, y: 396 - 16 - 8 });
        // a lower card of the third column: the gutter in the middle of the space left of the tiles
        expect(routes[4]).toContainEqual({ x: 1227 - 16 - 8, y: 334 - 16 - 8 });
        // without tiles, the entries stay in the middle of the cards' top edges
        expect(channelRoutes({ ...masonry, tiles: masonry.cards.map(() => null) })).toEqual(channelRoutes(masonry));
    });

    it("has nothing to reach without cards", () => {
        expect(channelRoutes({ ...masonry, cards: [] })).toEqual([]);
        expect(channelNetwork([]).runs).toEqual([]);
    });
});

describe("settings channels: the network", () => {
    const net = channelNetwork(channelRoutes(masonry));

    it("draws each shared part once, as a tree in the flow's direction", () => {
        const keys = net.runs.map((r) => `${r.a.x},${r.a.y}>${r.b.x},${r.b.y}`);
        expect(new Set(keys).size).toBe(keys.length);
        for (const r of net.runs) {
            expect(runLength(r)).toBeGreaterThan(0);
            expect(r.d1).toBeGreaterThan(r.d0);
            expect(r.d1 - r.d0).toBeCloseTo(runLength(r), 5);
        }
        // the lane under the row is shared by every route: one piece, starting at distance 0
        expect(net.runs.filter((r) => r.d0 === 0)).toHaveLength(1);
        // one branch ends at each card
        expect(
            net.runs
                .filter((r) => r.card != null)
                .map((r) => r.card)
                .sort()
        ).toEqual([0, 1, 2, 3, 4]);
    });

    it("rounds the pure turns with an elbow and leaves the tees square", () => {
        expect(net.elbows.length).toBeGreaterThan(0);
        for (const e of net.elbows) {
            const r = Math.abs(e.p0.x - e.p1.x) + Math.abs(e.p0.y - e.p1.y);
            expect(r).toBeGreaterThan(0);
            expect(r).toBeLessThanOrEqual(ChannelPx.elbow);
            // the curve meets the runs on both sides
            expect(net.runs.some((run) => run.b.x === e.p0.x && run.b.y === e.p0.y)).toBe(true);
            expect(net.runs.some((run) => run.a.x === e.p2.x && run.a.y === e.p2.y)).toBe(true);
        }
        // the spine meets the manifold in a tee (it goes on down to the lower card of the first column): not rounded
        expect(net.elbows.some((e) => e.p1.x === 16 && e.p1.y === 151)).toBe(false);
        // under the chip the lane turns left: rounded
        expect(net.elbows.some((e) => e.p1.x === 274 && e.p1.y === 51)).toBe(true);
    });

    it("reaches the cards along the pipework, the farthest last", () => {
        expect(net.lengths).toHaveLength(5);
        expect(net.reach).toBe(Math.max(...net.lengths));
        expect(net.lengths[0]).toBeLessThan(net.lengths[1]);
        expect(net.lengths[3]).toBeLessThan(net.lengths[4]);
        expect(net.entries[2]).toEqual({ x: 912, y: 167 });
    });

    it("is one SVG path of lines and quadratic elbows", () => {
        const d = networkPath(net);
        expect(d.match(/M/g)).toHaveLength(net.runs.length + net.elbows.length);
        expect(d.match(/Q/g)).toHaveLength(net.elbows.length);
    });
});

describe("settings channels: the ambient flow", () => {
    it("moves one tile per whole-second cycle, stepping on the 1/15 s grid, transform only, with no delay", () => {
        const timing = ambientTiming();
        expect(timing.iterations).toBe(Infinity);
        expect(timing.delay ?? 0).toBe(0);
        expect((timing.duration as number) % 1000).toBe(0);
        const steps = Number(/^steps\((\d+)\)$/.exec(timing.easing)?.[1]);
        expect(steps).toBe(((timing.duration as number) / 1000) * AmbientFlow.stepsPerSecond);
        // every step falls on a frame of the shared grid
        const stepMs = (timing.duration as number) / steps;
        const gridMs = 1000 / FrameGridPerSecond;
        expect(stepMs / gridMs).toBeCloseTo(Math.round(stepMs / gridMs), 9);
        expect(Math.round(stepMs / gridMs)).toBeGreaterThanOrEqual(1);
        const run = { a: { x: 0, y: 0 }, b: { x: 200, y: 0 }, axis: "x" as const, dir: 1 as const, d0: 0, d1: 200 };
        expect(ambientKeyframes(run)).toEqual([
            { transform: "translateX(0px)" },
            { transform: `translateX(${AmbientFlow.tile}px)` },
        ]);
        expect(ambientKeyframes({ ...run, axis: "y", dir: -1 })[1]).toEqual({
            transform: `translateY(${-AmbientFlow.tile}px)`,
        });
    });

    it("starts on a whole cycle of the document timeline", () => {
        expect(snappedStart(12345)).toBe(12000);
        expect(snappedStart(13345)).toBe(12000);
        expect(snappedStart(12345) % AmbientFlow.cycleMs).toBe(0);
    });

    it("stands still with the view and starts again on the grid", () => {
        const make = () => {
            const a = {
                startTime: 4000 as number,
                playState: "running" as AnimationPlayState,
                pause() {
                    a.playState = "paused";
                },
                cancel() {},
            };
            return a;
        };
        const anims = [make(), make()];
        setAmbientMotion(anims, false, 9000);
        expect(anims.every((a) => a.playState === "paused")).toBe(true);
        setAmbientMotion(anims, true, 9100);
        expect(anims.every((a) => a.startTime === snappedStart(9100))).toBe(true);
        expect(snappedStart(9100) % AmbientFlow.cycleMs).toBe(0);
    });

    it("is pre-painted, in the running colour, and gone under reduced motion", () => {
        const css = readFileSync("frontend/moltenterm-shell/library/library.css", "utf8");
        const tile = css.match(/\.mt-ch-flow-tile \{[^}]*\}/)?.[0] ?? "";
        expect(tile).toContain("will-change: transform");
        expect(tile).toContain("--mt-state-running");
        expect(tile).not.toContain("--mt-action");
        expect(css).toMatch(/\.prefers-reduced-motion \.mt-ch-layer \{\s*display: none;/);
        // no container query and no stroke animation around the channels
        const channels = css.slice(css.indexOf(".mt-ch-layer {"));
        expect(channels).not.toContain("@container");
        expect(channels).not.toContain("stroke-dashoffset");
    });
});

describe("the ambient flow costs no main-thread frame", () => {
    it("the sidebar's rest check asks for its animations only once everything else says it is at rest", () => {
        // getAnimations() forces a style update, which costs a main-thread frame while the channels' loops run; the
        // sidebar asks every 700 ms while the library is open (#1549).
        const sidebar = readFileSync("frontend/moltenterm-shell/sidebar/workspace-sidebar.tsx", "utf8");
        const rest = sidebar.slice(sidebar.indexOf("restRef.current = () => {"));
        const early = rest.indexOf("if (!sidebarAtRest(facts))");
        expect(early).toBeGreaterThan(0);
        expect(rest.indexOf("getAnimations")).toBeGreaterThan(early);
        expect(rest.slice(0, early)).toContain("animating: false");
    });
});
