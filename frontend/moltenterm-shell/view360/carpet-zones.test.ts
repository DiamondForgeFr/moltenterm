// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    dragZoneBorder,
    evenPercents,
    MinZonePx,
    planZoneInsert,
    readZoneShares,
    roundShares,
    sharesOf,
    withZoneShares,
    zoneColumnWidthsPx,
    zonesAreEven,
    zoneSharesOf,
    zoneWidthsPx,
} from "./carpet-zones";

const sum = (values: number[]) => values.reduce((acc, v) => acc + v, 0);

describe("the widths of the zones (FR-SHELL-123 AC18, AC19)", () => {
    it("shares a band into equal whole pixels without shares", () => {
        expect(zoneWidthsPx(1000, 2, null)).toEqual([500, 500]);
        expect(zoneWidthsPx(1001, 3, null)).toEqual([334, 333, 334]);
        expect(sum(zoneWidthsPx(1001, 3, null))).toBe(1001);
    });

    it("follows the shares and always fills the band", () => {
        for (const band of [900, 1234, 1999.7]) {
            const widths = zoneWidthsPx(band, 3, [0.2, 0.5, 0.3]);
            expect(sum(widths)).toBe(Math.floor(band));
        }
        expect(zoneWidthsPx(1000, 2, [0.3, 0.7])).toEqual([300, 700]);
    });

    it("keeps every zone at its minimum when the band shrinks under the shares", () => {
        const widths = zoneWidthsPx(900, 2, [0.1, 0.9]);
        expect(widths[0]).toBe(MinZonePx);
        expect(sum(widths)).toBe(900);
        const three = zoneWidthsPx(1000, 3, [0.05, 0.05, 0.9]);
        expect(three.slice(0, 2)).toEqual([MinZonePx, MinZonePx]);
        expect(sum(three)).toBe(1000);
    });

    it("shares equally when the band cannot hold the minimums", () => {
        expect(sum(zoneWidthsPx(500, 2, [0.1, 0.9]))).toBe(500);
    });
});

describe("a border dragged between two zones (AC18)", () => {
    it("trades width between its two neighbours only", () => {
        const widths = dragZoneBorder([400, 400, 400], 0, 500);
        expect(widths).toEqual([500, 300, 400]);
        expect(dragZoneBorder([400, 400, 400], 1, 700)).toEqual([400, 300, 500]);
    });

    it("keeps the sum, so no zone is added and no gap opens", () => {
        for (let edge = -100; edge < 1400; edge += 37) {
            for (const index of [0, 1]) {
                expect(sum(dragZoneBorder([400, 400, 400], index, edge))).toBe(1200);
            }
        }
    });

    it("stops at the minimum on each side", () => {
        expect(dragZoneBorder([400, 400], 0, 0)).toEqual([MinZonePx, 800 - MinZonePx]);
        expect(dragZoneBorder([400, 400], 0, 5000)).toEqual([800 - MinZonePx, MinZonePx]);
    });

    it("ignores a border that lies at the band's edge", () => {
        expect(dragZoneBorder([400, 400], 1, 600)).toEqual([400, 400]);
        expect(dragZoneBorder([400, 400], -1, 600)).toEqual([400, 400]);
    });
});

describe("the remembered shares (AC19)", () => {
    it("reads what the meta holds and nothing else", () => {
        expect(readZoneShares({ "2": [1, 3], "3": [1, 1, 2] })).toEqual({ "2": [0.25, 0.75], "3": [0.25, 0.25, 0.5] });
        expect(readZoneShares({ "2": [1, 1, 1], "4": [1, 1, 1, 1], "3": [1, "x", 1], "1": [1] })).toEqual({});
        expect(readZoneShares(null)).toEqual({});
        expect(readZoneShares([1, 2])).toEqual({});
    });

    it("keeps the shares of each number of zones apart", () => {
        const stored = withZoneShares(withZoneShares({}, 2, [0.3, 0.7]), 3, [0.2, 0.3, 0.5]);
        expect(zoneSharesOf(stored, 2)).toEqual([0.3, 0.7]);
        expect(zoneSharesOf(stored, 3)).toEqual([0.2, 0.3, 0.5]);
        expect(zoneSharesOf(stored, 1)).toBeNull();
    });

    it("forgets the shares of a number of zones that are even again", () => {
        const stored = withZoneShares({ "2": [0.3, 0.7], "3": [0.2, 0.3, 0.5] }, 2, [0.5, 0.5]);
        expect(stored).toEqual({ "3": [0.2, 0.3, 0.5] });
        expect(withZoneShares(stored, 3, null)).toEqual({});
    });

    it("rounds the shares so they still add up to one", () => {
        expect(sum(roundShares([1 / 3, 1 / 3, 1 / 3]))).toBeCloseTo(1, 10);
        expect(sharesOf([300, 700])).toEqual([0.3, 0.7]);
    });

    it("tells even zones from the ones the developer set", () => {
        expect(zonesAreEven(null, 2)).toBe(true);
        expect(zonesAreEven([0.5, 0.5], 2)).toBe(true);
        expect(zonesAreEven([0.495, 0.505], 2)).toBe(true);
        expect(zonesAreEven([0.33, 0.34, 0.33], 3)).toBe(true);
        expect(zonesAreEven([0.4, 0.6], 2)).toBe(false);
        expect(zonesAreEven([0.2, 0.3, 0.5], 3)).toBe(false);
    });
});

describe("Even out the zones (AC20)", () => {
    it("reads 50 / 50 for two zones and 33 / 34 / 33 for three, adding up to 100", () => {
        expect(evenPercents(2)).toEqual([50, 50]);
        expect(evenPercents(3)).toEqual([33, 34, 33]);
        expect(evenPercents(1)).toEqual([100]);
        for (const n of [1, 2, 3]) {
            expect(sum(evenPercents(n))).toBe(100);
        }
    });
});

describe("the widths of the carpet's columns around the zones in view (AC19)", () => {
    it("lays the zones' widths on the columns in view from the page, the first zone before and the widest after", () => {
        expect(zoneColumnWidthsPx([300, 700], 1, 5)).toEqual([300, 300, 700, 700, 700]);
        expect(zoneColumnWidthsPx([300, 700], 0, 3)).toEqual([300, 700, 700]);
        expect(zoneColumnWidthsPx([200, 500, 300], 2, 6)).toEqual([200, 200, 200, 500, 300, 500]);
    });

    it("always reaches the next whole place however the zones share the band", () => {
        const widths = zoneColumnWidthsPx([800, 300], 0, 3);
        const next = widths[0];
        const reach = sum(widths.slice(1));
        expect(reach).toBeGreaterThanOrEqual(next);
    });
});

describe("where a panel added under a 360 × N lands (AC17)", () => {
    // `count` carpet columns, the first in view at `page`, `n` zones.
    const at = (count: number, page: number, n: number, index: number, side: "before" | "after" = null) =>
        planZoneInsert(count, page, n, { kind: "column", index }, side);

    it("× 2: after the focused panel, which keeps its zone; the far panel on the right leaves the view", () => {
        expect(at(5, 0, 2, 0)).toEqual({ index: 1, start: 0 });
        expect(at(5, 2, 2, 2)).toEqual({ index: 3, start: 2 });
    });

    it("× 2, last zone: before the focused panel, which keeps its zone; the panel on the left leaves the view", () => {
        expect(at(5, 0, 2, 1)).toEqual({ index: 1, start: 1 });
        expect(at(5, 2, 2, 3)).toEqual({ index: 3, start: 3 });
    });

    it("× 3: first, middle and last zone", () => {
        expect(at(6, 1, 3, 1)).toEqual({ index: 2, start: 1 });
        expect(at(6, 1, 3, 2)).toEqual({ index: 3, start: 1 });
        expect(at(6, 1, 3, 3)).toEqual({ index: 3, start: 2 });
    });

    it("× 1: the new panel is the one in view", () => {
        expect(at(4, 1, 1, 1)).toEqual({ index: 2, start: 2 });
        expect(at(4, 1, 1, 1, "before")).toEqual({ index: 1, start: 1 });
    });

    it("a side asked for is kept, the carpet moving a zone so both panels stay in view", () => {
        expect(at(5, 0, 2, 1, "after")).toEqual({ index: 2, start: 1 });
        expect(at(5, 0, 2, 1, "before")).toEqual({ index: 1, start: 1 });
        expect(at(5, 0, 3, 0, "before")).toEqual({ index: 0, start: 0 });
    });

    it("from the fixed zone: the first zone, next to the agent", () => {
        expect(planZoneInsert(5, 0, 2, { kind: "fixed" })).toEqual({ index: 0, start: 0 });
        expect(planZoneInsert(5, 2, 2, { kind: "fixed" })).toEqual({ index: 2, start: 2 });
    });

    it("never starts the zones past the carpet's last full screen", () => {
        for (let count = 3; count <= 8; count++) {
            for (const n of [1, 2, 3]) {
                for (let page = 0; page <= count - n; page++) {
                    for (let index = page; index < page + n; index++) {
                        const plan = planZoneInsert(count, page, n, { kind: "column", index });
                        expect(plan.start).toBeGreaterThanOrEqual(0);
                        expect(plan.start).toBeLessThanOrEqual(count + 1 - n);
                        // The focused panel and the new one both stay in view, whatever the zones.
                        const focusedAfter = plan.index <= index ? index + 1 : index;
                        const inView = (i: number) => i >= plan.start && i < plan.start + n;
                        expect(inView(plan.index)).toBe(true);
                        if (n > 1) {
                            expect(inView(focusedAfter)).toBe(true);
                        }
                    }
                }
            }
        }
    });
});
