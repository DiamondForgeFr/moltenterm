// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    capList,
    columnsFor,
    FlowBlock,
    FlowGapYPx,
    FlowGutterPx,
    flowLayout,
    FlowResult,
    linesOnHover,
} from "./companion-flow-model";

const Widths = [420, 760, 1200];

// A few sets of heights, without the pair, so each block flows on its own.
const Sets: number[][] = [
    [120, 80, 300, 40, 220, 160],
    [400, 60, 60, 60, 60, 60, 60],
    [50, 50, 50, 50, 50, 50, 50, 50],
    [90, 410, 130, 75, 260, 30, 180, 120],
];

function blocksOf(heights: number[], prefix = "b"): FlowBlock[] {
    return heights.map((height, i) => ({ id: `${prefix}${i}`, height }));
}

function byColumn(result: FlowResult, blocks: FlowBlock[]) {
    const height = new Map(blocks.map((b) => [b.id, b.height]));
    const columns = new Map<number, { id: string; top: number; bottom: number }[]>();
    for (const p of result.items) {
        const list = columns.get(p.column) ?? [];
        list.push({ id: p.id, top: p.y, bottom: p.y + height.get(p.id) });
        columns.set(p.column, list);
    }
    return columns;
}

describe("the flow's columns (#2441)", () => {
    it("has one column under 640 px, two from 640 px and three from 956 px", () => {
        expect(columnsFor(420)).toBe(1);
        expect(columnsFor(639)).toBe(1);
        expect(columnsFor(640)).toBe(2);
        expect(columnsFor(760)).toBe(2);
        expect(columnsFor(955)).toBe(2);
        expect(columnsFor(956)).toBe(3);
        expect(columnsFor(1200)).toBe(3);
    });

    it("keeps one 24 px gutter at the edges and between columns", () => {
        const r = flowLayout(blocksOf([100, 100, 100]), 1200);
        expect(r.innerWidth).toBe(1200 - 2 * FlowGutterPx);
        expect(r.columnWidth * 3 + 2 * FlowGutterPx).toBeCloseTo(r.innerWidth);
        const xs = r.items.map((p) => p.x).sort((a, b) => a - b);
        expect(xs[1] - (xs[0] + r.columnWidth)).toBeCloseTo(FlowGutterPx);
    });
});

describe("the flow's invariants at 420, 760 and 1200 px (#2441)", () => {
    for (const width of Widths) {
        for (const heights of Sets) {
            it(`stacks ${heights.join("/")} at ${width} px with no gap, no overlap, the flow as tall as its tallest column`, () => {
                const blocks = blocksOf(heights);
                const r = flowLayout(blocks, width);
                const columns = byColumn(r, blocks);
                let tallest = 0;
                for (const list of columns.values()) {
                    list.sort((a, b) => a.top - b.top);
                    expect(list[0].top).toBe(0);
                    for (let i = 1; i < list.length; i++) {
                        expect(list[i].top).toBe(list[i - 1].bottom + FlowGapYPx);
                    }
                    tallest = Math.max(tallest, list[list.length - 1].bottom);
                }
                expect(r.height).toBe(tallest);
                expect(columns.size).toBeLessThanOrEqual(r.columns);
            });

            it(`moves only the blocks under a block that grows, in its column, for ${heights.join("/")} at ${width} px`, () => {
                const blocks = blocksOf(heights);
                const first = flowLayout(blocks, width);
                for (let g = 0; g < blocks.length; g++) {
                    const grown = blocks.map((b, i) => (i === g ? { ...b, height: b.height + 75 } : b));
                    const next = flowLayout(grown, width, first.assign);
                    const at = new Map(first.items.map((p) => [p.id, p]));
                    const target = at.get(blocks[g].id);
                    for (const p of next.items) {
                        const before = at.get(p.id);
                        expect(p.column).toBe(before.column);
                        const below = p.column === target.column && before.y > target.y;
                        expect(p.y).toBe(below ? before.y + 75 : before.y);
                    }
                }
            });
        }
    }

    it("puts each block in the shortest column, the leftmost on a tie", () => {
        const r = flowLayout(blocksOf([300, 100, 100, 50]), 1200);
        expect(r.items.map((p) => p.column)).toEqual([0, 1, 2, 1]);
    });

    it("keeps each block's column while the column count stays: only a new block is placed anew", () => {
        const blocks = blocksOf([300, 100, 100, 50]);
        const first = flowLayout(blocks, 1200);
        // b1 grows past b0: sticky, b3 stays under b1.
        const grown = flowLayout(
            blocks.map((b) => (b.id === "b1" ? { ...b, height: 900 } : b)),
            1200,
            first.assign
        );
        expect(grown.items.find((p) => p.id === "b3").column).toBe(1);
        // A block hidden leaves the others where they stand.
        const fewer = flowLayout(
            blocks.filter((b) => b.id !== "b2").map((b) => (b.id === "b1" ? { ...b, height: 900 } : b)),
            1200,
            grown.assign
        );
        expect(fewer.items.map((p) => [p.id, p.column])).toEqual([
            ["b0", 0],
            ["b1", 1],
            ["b3", 1],
        ]);
        // Another column count chooses the columns again.
        expect(flowLayout(blocks, 760, fewer.assign).items.map((p) => p.column)).toEqual([0, 1, 1, 1]);
    });

    it("never swaps the columns as the permission request comes and goes, whatever the heights became", () => {
        const topics: FlowBlock = { id: "topics", height: 120 };
        const files: FlowBlock = { id: "files", height: 300 };
        const answer: FlowBlock = { id: "answer", height: 80 };
        const permission: FlowBlock = { id: "permission", height: 140, full: true };
        let r = flowLayout([topics, files, answer], 760);
        const columns = () => Object.fromEntries(r.items.map((p) => [p.id, p.column]));
        const start = columns();
        expect(start).toEqual({ topics: 0, files: 1, answer: 0 });
        // Topics grows past files: a fresh pass would now put answer under files.
        const taller = { ...topics, height: 600 };
        r = flowLayout([taller, files, answer], 760, r.assign);
        expect(columns()).toEqual(start);
        for (let i = 0; i < 3; i++) {
            r = flowLayout([permission, taller, files, answer], 760, r.assign);
            expect(columns()).toEqual({ ...start, permission: 0 });
            expect(r.items.find((p) => p.id === "answer").y).toBe(140 + FlowGapYPx + 600 + FlowGapYPx);
            r = flowLayout([taller, files, answer], 760, r.assign);
            expect(columns()).toEqual(start);
        }
    });

    it("leaves nothing for an empty flow", () => {
        expect(flowLayout([], 760).height).toBe(0);
    });
});

describe("a full-width block (#2441)", () => {
    it("starts under the tallest column and spans every column", () => {
        const blocks: FlowBlock[] = [
            { id: "a", height: 100 },
            { id: "b", height: 300 },
            { id: "w", height: 80, full: true },
            { id: "c", height: 50 },
        ];
        const r = flowLayout(blocks, 760);
        const w = r.items.find((p) => p.id === "w");
        expect(w).toMatchObject({ x: 0, y: 300 + FlowGapYPx, width: r.innerWidth, full: true });
        const c = r.items.find((p) => p.id === "c");
        expect(c.y).toBe(w.y + 80 + FlowGapYPx);
        expect(r.height).toBe(c.y + 50);
    });

    it("shows a first full-width block right at the top, and flows like the others in one column", () => {
        const blocks: FlowBlock[] = [
            { id: "permission", height: 120, full: true },
            { id: "a", height: 100 },
        ];
        expect(flowLayout(blocks, 1200).items[0]).toMatchObject({ y: 0, width: 1200 - 2 * FlowGutterPx });
        const narrow = flowLayout(blocks, 420);
        expect(narrow.items[0]).toMatchObject({ y: 0, full: false, width: narrow.columnWidth });
        expect(narrow.items[1].y).toBe(120 + FlowGapYPx);
    });
});

describe("the milestone and the agents at work, a pair (#2441)", () => {
    const pairSet: FlowBlock[] = [
        { id: "usage", height: 200 },
        { id: "tasks", height: 400 },
        { id: "agents", height: 150 },
        { id: "topics", height: 90 },
        { id: "files", height: 60 },
    ];

    for (const width of [760, 1200]) {
        it(`stands side by side and top-aligned at ${width} px, in two adjacent columns`, () => {
            const r = flowLayout(pairSet, width);
            const t = r.items.find((p) => p.id === "tasks");
            const a = r.items.find((p) => p.id === "agents");
            expect(r.paired).toBe(true);
            expect(a.column).toBe(t.column + 1);
            expect(a.y).toBe(t.y);
            const columns = byColumn(r, pairSet);
            for (const list of columns.values()) {
                list.sort((x, y) => x.top - y.top);
                for (let i = 1; i < list.length; i++) {
                    expect(list[i].top).toBeGreaterThanOrEqual(list[i - 1].bottom + FlowGapYPx);
                }
            }
        });
    }

    it("takes the two adjacent columns whose taller one is the shortest", () => {
        const r = flowLayout(
            [
                { id: "x", height: 500 },
                { id: "tasks", height: 100 },
                { id: "agents", height: 100 },
            ],
            1200
        );
        expect(r.items.find((p) => p.id === "tasks").column).toBe(1);
        expect(r.items.find((p) => p.id === "tasks").y).toBe(0);
    });

    it("is never split: the agents come right after the milestone even when the order puts something between", () => {
        const r = flowLayout(
            [
                { id: "agents", height: 100 },
                { id: "usage", height: 50 },
                { id: "tasks", height: 200 },
            ],
            760
        );
        const t = r.items.find((p) => p.id === "tasks");
        const a = r.items.find((p) => p.id === "agents");
        expect([t.column, a.column, t.y, a.y]).toEqual([0, 1, 0, 0]);
    });

    it("flows like the others in one column, while arranging, or when one of the two takes the full width", () => {
        expect(flowLayout(pairSet, 420).paired).toBe(false);
        expect(flowLayout(pairSet, 1200, undefined, { arranging: true }).paired).toBe(false);
        const wide = pairSet.map((b) => (b.id === "agents" ? { ...b, full: true } : b));
        expect(flowLayout(wide, 1200).paired).toBe(false);
    });
});

describe("the dashboard's lists and lines (#2441)", () => {
    it("shows the lines only on hover beyond 6 links", () => {
        expect(linesOnHover(0)).toBe(false);
        expect(linesOnHover(6)).toBe(false);
        expect(linesOnHover(7)).toBe(true);
    });

    it("caps a list at 8 rows, the rest counted, all of them once opened", () => {
        const list = Array.from({ length: 20 }, (_, i) => i);
        expect(capList(list, false)).toEqual({ shown: list.slice(0, 8), more: 12 });
        expect(capList(list, true)).toEqual({ shown: list, more: 0 });
        expect(capList(list.slice(0, 8), false)).toEqual({ shown: list.slice(0, 8), more: 0 });
    });
});
