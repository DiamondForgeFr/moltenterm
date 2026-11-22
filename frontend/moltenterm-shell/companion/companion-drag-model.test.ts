// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
    dragCorner,
    DragStartPx,
    dropIndexAt,
    LongPressMs,
    LongPressSlopPx,
    passedDragStart,
    pointInBox,
    PressTimers,
    startLongPress,
    startsPress,
} from "./companion-drag-model";
import { FlowBlock, flowLayout, PairIds } from "./companion-flow-model";

// Timers that only run when the test says so: no wall clock anywhere, so the machine's load decides nothing.
function fakeTimers() {
    const pending = new Map<number, { run: () => void; ms: number }>();
    let next = 1;
    const timers: PressTimers = {
        set: (run, ms) => {
            pending.set(next, { run, ms });
            return next++;
        },
        clear: (handle) => {
            pending.delete(handle as number);
        },
    };
    return {
        timers,
        pending: () => [...pending.values()],
        fire: () => {
            const [id, timer] = [...pending.entries()][0] ?? [];
            if (timer == null) {
                return;
            }
            pending.delete(id);
            timer.run();
        },
    };
}

describe("the long press that picks a block up (#2459)", () => {
    it("waits about half a second, then fires once, where the pointer is by then", () => {
        const clock = fakeTimers();
        const fired: { x: number; y: number }[] = [];
        const press = startLongPress({ x: 10, y: 20, onFire: (at) => fired.push(at), timers: clock.timers });
        expect(LongPressMs).toBe(500);
        expect(clock.pending().map((t) => t.ms)).toEqual([LongPressMs]);
        expect(press.state()).toBe("pressing");
        press.move(13, 22);
        expect(fired).toEqual([]);
        clock.fire();
        expect(fired).toEqual([{ x: 13, y: 22 }]);
        expect(press.state()).toBe("fired");
        clock.fire();
        expect(fired).toHaveLength(1);
    });

    it("does nothing for a press shorter than the delay: the release stops the timer", () => {
        const clock = fakeTimers();
        const fired: unknown[] = [];
        const press = startLongPress({ x: 0, y: 0, onFire: (at) => fired.push(at), timers: clock.timers });
        press.release();
        expect(press.state()).toBe("released");
        expect(clock.pending()).toEqual([]);
        clock.fire();
        expect(fired).toEqual([]);
    });

    it("lets the pointer wander a few pixels, and gives the press up beyond them", () => {
        const slop = LongPressSlopPx;
        const steady = fakeTimers();
        const kept = startLongPress({ x: 100, y: 100, onFire: () => {}, timers: steady.timers });
        kept.move(100 + slop, 100);
        kept.move(100, 100 - slop);
        expect(kept.state()).toBe("pressing");
        expect(steady.pending()).toHaveLength(1);

        const moving = fakeTimers();
        const fired: unknown[] = [];
        const lost = startLongPress({ x: 100, y: 100, onFire: (at) => fired.push(at), timers: moving.timers });
        lost.move(100 + slop + 1, 100);
        expect(lost.state()).toBe("cancelled");
        expect(moving.pending()).toEqual([]);
        moving.fire();
        expect(fired).toEqual([]);
    });

    it("measures the slop from where the press began, not from the last move", () => {
        const clock = fakeTimers();
        const press = startLongPress({ x: 0, y: 0, onFire: () => {}, timers: clock.timers });
        for (let x = 2; x <= LongPressSlopPx; x += 2) {
            press.move(x, 0);
        }
        expect(press.state()).toBe("pressing");
        press.move(LongPressSlopPx + 4, 0);
        expect(press.state()).toBe("cancelled");
    });

    it("gives the press up when the pointer is cancelled (a scroll took it), and never after it fired", () => {
        const clock = fakeTimers();
        const press = startLongPress({ x: 0, y: 0, onFire: () => {}, timers: clock.timers });
        press.cancel();
        expect(press.state()).toBe("cancelled");
        expect(clock.pending()).toEqual([]);

        const done = fakeTimers();
        const fired = startLongPress({ x: 0, y: 0, onFire: () => {}, timers: done.timers });
        done.fire();
        fired.move(500, 500);
        fired.release();
        fired.cancel();
        expect(fired.state()).toBe("fired");
    });

    it("takes a delay and a slop of its own", () => {
        const clock = fakeTimers();
        const press = startLongPress({ x: 0, y: 0, delayMs: 120, slopPx: 2, onFire: () => {}, timers: clock.timers });
        expect(clock.pending().map((t) => t.ms)).toEqual([120]);
        press.move(3, 0);
        expect(press.state()).toBe("cancelled");
    });

    it("fills the ring round the icon for exactly as long as the press needs", () => {
        const css = readFileSync(resolve(__dirname, "companion-dashboard.css"), "utf8");
        const rule = /\.mt-cb-tile\[data-pressing\]::after\s*\{[^}]*animation:\s*mt-press-fill\s+(\d+)ms\s+linear/.exec(
            css
        );
        expect(rule?.[1]).toBe(String(LongPressMs));
        // The ring is set by the press alone: the attribute it reads is the one the press puts on the tile.
        const dashboard = readFileSync(resolve(__dirname, "companion-dashboard.tsx"), "utf8");
        expect(dashboard).toContain('tile.setAttribute("data-pressing", "")');
        expect(dashboard).toContain('tile.removeAttribute("data-pressing")');
    });

    it("starts on the primary button of a mouse and the one contact of a pen or a finger", () => {
        expect(startsPress({ button: 0, isPrimary: true, pointerType: "mouse" })).toBe(true);
        expect(startsPress({ button: 2, isPrimary: true, pointerType: "mouse" })).toBe(false);
        expect(startsPress({ button: 1, isPrimary: true, pointerType: "mouse" })).toBe(false);
        expect(startsPress({ button: 0, isPrimary: true, pointerType: "touch" })).toBe(true);
        expect(startsPress({ button: -1, isPrimary: true, pointerType: "pen" })).toBe(true);
        expect(startsPress({ button: 0, isPrimary: false, pointerType: "touch" })).toBe(false);
    });
});

describe("the drag itself (#2459)", () => {
    it("is a click until the pointer moved a few pixels", () => {
        expect(passedDragStart({ x: 5, y: 5 }, { x: 5, y: 5 + DragStartPx - 1 })).toBe(false);
        expect(passedDragStart({ x: 5, y: 5 }, { x: 5 + 3, y: 5 + 3 })).toBe(true);
    });

    it("keeps the block under the pointer where it was picked up", () => {
        expect(dragCorner({ x: 200, y: 340 }, { x: 18, y: 9 })).toEqual({ x: 182, y: 331 });
    });

    it("tells whether a point is in a box, with some slack for a drop that lands beside it", () => {
        const box = { x: 10, y: 10, width: 100, height: 40 };
        expect(pointInBox({ x: 50, y: 30 }, box)).toBe(true);
        expect(pointInBox({ x: 9, y: 30 }, box)).toBe(false);
        expect(pointInBox({ x: 9, y: 30 }, box, 12)).toBe(true);
        expect(pointInBox({ x: 50, y: 63 }, box, 12)).toBe(false);
    });
});

// Heights of the blocks as the flow lays them out, the main ones taller than the ghosts of the blocks with nothing to show.
const Folded: FlowBlock[] = [
    { id: "permission", height: 60, full: true },
    { id: "tasks", height: 60 },
    { id: "agents", height: 60 },
    { id: "usage", height: 100 },
    { id: "topics", height: 60 },
    { id: "answer", height: 60 },
    { id: "task", height: 60 },
    { id: "files", height: 60 },
];

const WidthOf = (columns: 1 | 2 | 3) => (columns === 1 ? 420 : columns === 2 ? 760 : 1200);

// The center of a block's slot where the flow would put it at `index` of the list.
function centerOf(blocks: FlowBlock[], id: string, index: number, width: number) {
    const dragged = blocks.find((b) => b.id === id);
    const others = blocks.filter((b) => b.id !== id);
    const order = [...others.slice(0, index), dragged, ...others.slice(index)];
    const slot = flowLayout(order, width).items[index];
    return { x: slot.x + slot.width / 2, y: slot.y + dragged.height / 2 };
}

describe("where a dragged block lands in the list (#2459)", () => {
    it("drops each block at the index whose slot it covers, in every column count", () => {
        for (const columns of [1, 2, 3] as const) {
            const width = WidthOf(columns);
            for (const dragged of Folded) {
                for (let index = 0; index < Folded.length; index++) {
                    const center = centerOf(Folded, dragged.id, index, width);
                    const got = dropIndexAt(Folded, dragged.id, width, center);
                    // Two indexes can give the same place to a full-width block, or beside the pair (a block between
                    // the milestone and the agents stands under both): the slot is what the pointer covers, so either
                    // index is right.
                    expect(centerOf(Folded, dragged.id, got, width), `${dragged.id} to ${index} in ${columns}`).toEqual(
                        center
                    );
                    if (!dragged.full && !PairIds.includes(dragged.id) && columns === 1) {
                        expect(got, `${dragged.id} to ${index} in ${columns}`).toBe(index);
                    }
                }
            }
        }
    });

    it("gives the same index for a block anywhere in the list: only the pointer decides", () => {
        const width = WidthOf(1);
        const center = centerOf(Folded, "files", 2, width);
        const rotated = [...Folded.slice(3), ...Folded.slice(0, 3)];
        expect(dropIndexAt(Folded, "files", width, center)).toBe(2);
        expect(dropIndexAt(rotated, "files", width, center)).toBe(2);
    });

    it("takes the first place for a pointer above the list and the last for one below it", () => {
        const width = WidthOf(1);
        expect(dropIndexAt(Folded, "usage", width, { x: 200, y: -500 })).toBe(0);
        expect(dropIndexAt(Folded, "usage", width, { x: 200, y: 5000 })).toBe(Folded.length - 1);
        expect(dropIndexAt(Folded, "permission", width, { x: 200, y: 5000 })).toBe(Folded.length - 1);
    });

    it("never moves a block that stays where its own slot is", () => {
        for (const width of [WidthOf(1), WidthOf(2), WidthOf(3)]) {
            for (let from = 0; from < Folded.length; from++) {
                const dragged = Folded[from];
                const center = centerOf(Folded, dragged.id, from, width);
                expect(dropIndexAt(Folded, dragged.id, width, center)).toBe(from);
            }
        }
    });

    it("keeps the current index on a tie, so a block does not flicker between two slots", () => {
        const width = WidthOf(1);
        const equal: FlowBlock[] = [
            { id: "a", height: 50 },
            { id: "b", height: 50 },
            { id: "c", height: 50 },
        ];
        const between = {
            x: centerOf(equal, "b", 1, width).x,
            y: (centerOf(equal, "b", 0, width).y + centerOf(equal, "b", 1, width).y) / 2,
        };
        expect(dropIndexAt(equal, "b", width, between)).toBe(1);
        const above = dropIndexAt([equal[1], equal[0], equal[2]], "b", width, { x: between.x, y: between.y });
        expect(above).toBe(0);
    });

    it("does not oscillate: the answer for a pointer is the same wherever the block is in the list", () => {
        const width = WidthOf(1);
        const tall: FlowBlock[] = [
            { id: "a", height: 40 },
            { id: "b", height: 300 },
            { id: "c", height: 40 },
            { id: "d", height: 120 },
        ];
        for (let y = -20; y < 700; y += 7) {
            const center = { x: 200, y };
            const seen = new Set<number>();
            for (let from = 0; from < tall.length; from++) {
                const order = [...tall.filter((b) => b.id !== "c")];
                order.splice(from, 0, tall[2]);
                seen.add(dropIndexAt(order, "c", width, center));
            }
            expect(seen.size, `y ${y}`).toBe(1);
        }
    });

    it("sends a block to the other column when the pointer is over it", () => {
        const width = WidthOf(2);
        const blocks: FlowBlock[] = [
            { id: "a", height: 120 },
            { id: "b", height: 120 },
            { id: "c", height: 120 },
            { id: "d", height: 120 },
        ];
        const right = flowLayout(blocks, width).items;
        expect(right.map((p) => p.column)).toEqual([0, 1, 0, 1]);
        const overB = { x: right[1].x + right[1].width / 2, y: right[1].y + 60 };
        expect(dropIndexAt(blocks, "c", width, overB)).toBe(1);
        const overD = { x: right[3].x + right[3].width / 2, y: right[3].y + 60 };
        expect(dropIndexAt(blocks, "a", width, overD)).toBe(3);
    });

    it("answers -1 for a block that is not in the list", () => {
        expect(dropIndexAt(Folded, "nothing", WidthOf(1), { x: 0, y: 0 })).toBe(-1);
    });
});
