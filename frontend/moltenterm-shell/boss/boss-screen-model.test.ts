// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { BubbleSizePx, Corner, Corners } from "./boss-place";
import {
    holdAfter,
    NoScreenHold,
    overRound,
    overZone,
    Point,
    pointerOver,
    ScreenEvent,
    ScreenHold,
    screenShows,
    ScreenSizePx,
    screenZone,
} from "./boss-screen-model";

const Free = { dragging: false, cardOpen: false };

function after(...events: ScreenEvent[]): ScreenHold {
    return events.reduce(holdAfter, NoScreenHold);
}

describe("what holds the screen open (AC12)", () => {
    it("opens on the pointer or on the keyboard focus, and on nothing else", () => {
        expect(screenShows(NoScreenHold, Free)).toBe(false);
        expect(screenShows(after("pointer-enter"), Free)).toBe(true);
        expect(screenShows(after("focus"), Free)).toBe(true);
    });

    it("closes at once when the pointer leaves, or the focus goes", () => {
        expect(screenShows(after("pointer-enter", "pointer-leave"), Free)).toBe(false);
        expect(screenShows(after("focus", "blur"), Free)).toBe(false);
    });

    it("stays open for the one that is left when the other goes", () => {
        expect(screenShows(after("pointer-enter", "focus", "pointer-leave"), Free)).toBe(true);
        expect(screenShows(after("pointer-enter", "focus", "blur"), Free)).toBe(true);
        expect(screenShows(after("pointer-enter", "focus", "pointer-leave", "blur"), Free)).toBe(false);
    });

    it("stays the round while the bubble is dragged and while the card is open", () => {
        const hold = after("pointer-enter", "focus");
        expect(screenShows(hold, { dragging: true, cardOpen: false })).toBe(false);
        expect(screenShows(hold, { dragging: false, cardOpen: true })).toBe(false);
        expect(screenShows(hold, Free)).toBe(true);
    });

    it("is hidden by Escape until the pointer or the focus comes back", () => {
        const hidden = after("pointer-enter", "focus", "dismiss");
        expect(screenShows(hidden, Free)).toBe(false);
        expect(screenShows(holdAfter(hidden, "pointer-leave"), Free)).toBe(false);
        expect(screenShows(holdAfter(holdAfter(hidden, "pointer-leave"), "pointer-enter"), Free)).toBe(true);
        expect(screenShows(holdAfter(holdAfter(hidden, "blur"), "focus"), Free)).toBe(true);
    });

    it("forgets everything on a reset, which a drag or a fold asks for", () => {
        expect(holdAfter(after("pointer-enter", "focus", "dismiss"), "reset")).toBe(NoScreenHold);
    });

    it("gives back the very same object when an event changes nothing, so no one draws again", () => {
        const entered = after("pointer-enter");
        expect(holdAfter(entered, "pointer-enter")).toBe(entered);
        expect(holdAfter(NoScreenHold, "pointer-leave")).toBe(NoScreenHold);
        expect(holdAfter(NoScreenHold, "blur")).toBe(NoScreenHold);
        expect(holdAfter(NoScreenHold, "reset")).toBe(NoScreenHold);
        const focused = after("focus");
        expect(holdAfter(focused, "focus")).toBe(focused);
    });
});

describe("the zone that holds the screen open (AC12)", () => {
    it("takes the round's two edges on the corner's side, so the screen grows toward the inside", () => {
        const grow = ScreenSizePx - BubbleSizePx;
        expect(screenZone("tl")).toEqual({ left: 0, top: 0, width: ScreenSizePx, height: ScreenSizePx });
        expect(screenZone("tr")).toEqual({ left: -grow, top: 0, width: ScreenSizePx, height: ScreenSizePx });
        expect(screenZone("bl")).toEqual({ left: 0, top: -grow, width: ScreenSizePx, height: ScreenSizePx });
        expect(screenZone("br")).toEqual({ left: -grow, top: -grow, width: ScreenSizePx, height: ScreenSizePx });
    });

    it("holds the whole round, whichever the corner", () => {
        for (const corner of Corners) {
            const zone = screenZone(corner);
            expect(zone.left).toBeLessThanOrEqual(0);
            expect(zone.top).toBeLessThanOrEqual(0);
            expect(zone.left + zone.width).toBeGreaterThanOrEqual(BubbleSizePx);
            expect(zone.top + zone.height).toBeGreaterThanOrEqual(BubbleSizePx);
        }
    });

    it("finds the pointer on the round only while closed, and on the whole zone once open", () => {
        const far: Point = { x: -100, y: -100 };
        expect(pointerOver(far, "br", false)).toBe(false);
        expect(pointerOver(far, "br", true)).toBe(true);
        expect(pointerOver(far, "tl", true)).toBe(false);
        expect(overRound({ x: 22, y: 22 })).toBe(true);
        expect(overRound({ x: 1, y: 1 })).toBe(false);
        expect(overZone({ x: 1, y: 1 }, "tl")).toBe(true);
    });
});

type Hit = (point: Point, open: boolean) => boolean;

// What the browser does with a pointer: each position is hit-tested, an entry or an exit is told to the bubble, the
// screen opens or closes accordingly, and the layout change is hit-tested again at the same position until nothing
// changes. A loop shows as a position that never settles, or as the screen opening and closing again and again.
function run(path: Point[], hit: Hit): { changes: number; settled: boolean; opens: boolean[] } {
    let hold = NoScreenHold;
    let open = false;
    let over = false;
    let changes = 0;
    let settled = true;
    const opens: boolean[] = [];
    for (const point of path) {
        let stable = false;
        for (let round = 0; round < 8 && !stable; round++) {
            const now = hit(point, open);
            if (now !== over) {
                over = now;
                hold = holdAfter(hold, now ? "pointer-enter" : "pointer-leave");
            }
            const next = screenShows(hold, Free);
            stable = next === open;
            if (!stable) {
                open = next;
                changes++;
            }
        }
        settled = settled && stable;
        opens.push(open);
    }
    return { changes, settled, opens };
}

const RoundCentre = BubbleSizePx / 2;

function onEdge(angle: number, radius: number): Point {
    return { x: RoundCentre + radius * Math.cos(angle), y: RoundCentre + radius * Math.sin(angle) };
}

function realHit(corner: Corner): Hit {
    return (point, open) => pointerOver(point, corner, open);
}

describe("a pointer on the round's edge gives no open and close loop (AC12)", () => {
    // Every few degrees round the rim, a hair inside it, on it and a hair outside it.
    const radii = [RoundCentre - 0.5, RoundCentre - 0.01, RoundCentre, RoundCentre + 0.01, RoundCentre + 0.5];
    const angles = Array.from({ length: 72 }, (_, i) => (i * Math.PI * 2) / 72);

    it.each(Corners)("settles at every point of the rim, in the %s corner, with at most one change", (corner) => {
        for (const radius of radii) {
            for (const angle of angles) {
                const result = run([onEdge(angle, radius)], realHit(corner));
                expect(result.settled).toBe(true);
                expect(result.changes).toBeLessThanOrEqual(1);
                expect(result.opens.at(-1)).toBe(overRound(onEdge(angle, radius)));
            }
        }
    });

    it.each(Corners)(
        "opens once when the pointer jitters across the rim, and never closes while in the zone (%s)",
        (corner) => {
            const path: Point[] = [];
            for (let i = 0; i < 400; i++) {
                path.push(onEdge(0.9, RoundCentre + (i % 2 === 0 ? -0.6 : 0.6)));
            }
            const result = run(path, realHit(corner));
            expect(result.settled).toBe(true);
            expect(result.changes).toBe(1);
            expect(result.opens.at(-1)).toBe(true);
        }
    );

    it("opens from the round only, and closes only once the pointer has left the whole zone", () => {
        const corner: Corner = "br";
        const zone = screenZone(corner);
        const inZoneOutsideRound: Point = { x: zone.left + 5, y: zone.top + 5 };
        const outsideZone: Point = { x: zone.left - 5, y: zone.top - 5 };
        expect(overRound(inZoneOutsideRound)).toBe(false);
        // From the zone's area, with the screen closed: nothing opens.
        expect(run([inZoneOutsideRound], realHit(corner)).opens).toEqual([false]);
        // From the round, then out across the zone: it stays open until the pointer is out of the zone.
        const path: Point[] = [{ x: 22, y: 22 }, { x: 0, y: 0 }, { x: -60, y: -60 }, inZoneOutsideRound, outsideZone];
        const result = run(path, realHit(corner));
        expect(result.settled).toBe(true);
        expect(result.opens).toEqual([true, true, true, true, false]);
        // Out of the zone, the area it took is no longer the pointer's, and the pointer does not bring it back.
        expect(run([...path, inZoneOutsideRound], realHit(corner)).opens.at(-1)).toBe(false);
    });

    it("would loop if the open zone left part of the round out, which the test would catch", () => {
        // A zone that grows away from the pointer instead of round it: the pointer on the rim is out of it as soon as
        // the screen opens, so it closes, and the round takes the pointer in again.
        const away: Hit = (point, open) =>
            open ? point.x >= BubbleSizePx && point.y >= BubbleSizePx && overZone(point, "tl") : overRound(point);
        const result = run([onEdge(Math.PI / 4, RoundCentre - 0.5)], away);
        expect(result.settled).toBe(false);
    });
});
