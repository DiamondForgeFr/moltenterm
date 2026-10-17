// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { describe, expect, it } from "vitest";
import {
    anyColumnTooTight,
    autoWants,
    columnMinimumsPx,
    columnsParent,
    countLeaves,
    decideView360,
    exitView360,
    FirstColumnMinPx,
    fitsAtCurrentFloors,
    fitsAtReadableMinimums,
    LeaveMarginPx,
    manualChoice,
    maxReadableColumns,
    minimumsPx,
    normalColumnPxs,
    normalizeView360Setting,
    sharedColumnSizes,
    SideColumnMinPx,
    topColumns,
} from "./view360-decision";

function leaf(id: string, size = 10): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size, data: { blockId: `b-${id}` } };
}

function row(...children: LayoutNode[]): LayoutNode {
    return { id: "root", flexDirection: FlexDirection.Row, size: 10, children };
}

describe("360 view decision (FR-SHELL-066, DS-SHELL-116)", () => {
    it("reads the setting and the tab's manual choice", () => {
        expect(normalizeView360Setting(undefined)).toBe("auto");
        expect(normalizeView360Setting("bogus")).toBe("auto");
        expect(normalizeView360Setting("always")).toBe("always");
        // "never" was removed (#733): a stored one reads as automatic.
        expect(normalizeView360Setting("never")).toBe("auto");
        expect(manualChoice(true)).toBe(true);
        expect(manualChoice(false)).toBe(false);
        expect(manualChoice(undefined)).toBeNull();
        expect(manualChoice("on")).toBeNull();
    });

    it("counts the top-level columns, a vertically split column as one", () => {
        expect(topColumns(null)).toEqual([]);
        expect(topColumns(leaf("a")).length).toBe(1);
        const stack: LayoutNode = {
            id: "s",
            flexDirection: FlexDirection.Column,
            size: 10,
            children: [leaf("a"), leaf("b")],
        };
        expect(topColumns(stack).length).toBe(1);
        expect(topColumns(row(stack, leaf("c"), leaf("d"))).map((c) => c.id)).toEqual(["s", "c", "d"]);
        // A wrapper holding a single child is looked through.
        expect(
            topColumns({
                id: "w",
                flexDirection: FlexDirection.Column,
                size: 10,
                children: [row(leaf("a"), leaf("b"))],
            }).length
        ).toBe(2);
    });

    it("counts the panels, splits included", () => {
        expect(countLeaves(null)).toBe(0);
        expect(countLeaves(leaf("a"))).toBe(1);
        const stack: LayoutNode = {
            id: "s",
            flexDirection: FlexDirection.Column,
            size: 10,
            children: [leaf("a"), leaf("b")],
        };
        expect(countLeaves(row(stack, leaf("c")))).toBe(3);
    });

    it("needs the first column's minimum plus a side minimum and a gap per other column", () => {
        expect(minimumsPx(1)).toBe(FirstColumnMinPx);
        expect(minimumsPx(3, 4)).toBe(FirstColumnMinPx + 2 * (SideColumnMinPx + 4));
        expect(FirstColumnMinPx).toBe(520);
        expect(SideColumnMinPx).toBe(360);
    });

    it("enters automatically when a column would fall under its minimum", () => {
        // 520 + 360 + 360 = 1240
        expect(autoWants(false, 3, 1300)).toBe(false);
        expect(autoWants(false, 3, 1239)).toBe(true);
        expect(autoWants(false, 4, 1440)).toBe(true);
    });

    it("leaves only once everything fits with the margin (hysteresis)", () => {
        const need = minimumsPx(3);
        expect(autoWants(true, 3, need + 1)).toBe(true);
        expect(autoWants(true, 3, need + LeaveMarginPx - 1)).toBe(true);
        expect(autoWants(true, 3, need + LeaveMarginPx)).toBe(false);
    });

    it("does not flap when the width moves back and forth around the threshold", () => {
        const need = minimumsPx(3);
        let on = false;
        let switches = 0;
        for (const width of [need + 10, need - 5, need + 10, need - 5, need + 30, need - 2, need + 40]) {
            const next = autoWants(on, 3, width);
            if (next !== on) {
                switches++;
            }
            on = next;
        }
        expect(switches).toBe(1);
        expect(on).toBe(true);
        expect(autoWants(on, 3, need + LeaveMarginPx + 10)).toBe(false);
    });

    it("never wants 360 view for a single column", () => {
        expect(autoWants(false, 1, 100)).toBe(false);
        expect(autoWants(true, 1, 100)).toBe(false);
        expect(decideView360({ setting: "always", manual: null, autoOn: false, columnCount: 1 })).toEqual({
            active: false,
            wanted: true,
            source: "setting",
        });
        expect(decideView360({ setting: "auto", manual: true, autoOn: false, columnCount: 1 }).active).toBe(false);
    });

    it("follows the setting, turns on on demand, and the automatic decision cannot be turned off (#733)", () => {
        const base = { autoOn: true, columnCount: 3 };
        expect(decideView360({ ...base, setting: "auto", manual: null })).toEqual({
            active: true,
            wanted: true,
            source: "auto",
        });
        expect(decideView360({ ...base, setting: "auto", manual: null, autoOn: false })).toEqual({
            active: false,
            wanted: false,
            source: "auto",
        });
        expect(decideView360({ ...base, setting: "always", manual: null, autoOn: false })).toEqual({
            active: true,
            wanted: true,
            source: "setting",
        });
        // On demand, even when the automatic decision did not trigger it.
        expect(decideView360({ ...base, setting: "auto", manual: true, autoOn: false })).toEqual({
            active: true,
            wanted: true,
            source: "manual",
        });
        // A tab turned off (false) still follows the automatic decision.
        expect(decideView360({ ...base, setting: "auto", manual: false })).toEqual({
            active: true,
            wanted: true,
            source: "auto",
        });
        expect(decideView360({ ...base, setting: "always", manual: false }).source).toBe("auto");
        // Under the always setting, a tab turned off stays off while everything fits.
        expect(decideView360({ ...base, setting: "always", manual: false, autoOn: false })).toEqual({
            active: false,
            wanted: false,
            source: "manual",
        });
        expect(decideView360({ ...base, setting: "auto", manual: false, autoOn: false }).active).toBe(false);
    });

    it("measures the normal columns and finds the one too tight to read", () => {
        const pxs = normalColumnPxs([50, 25, 25], 1204, 2);
        expect(pxs.map(Math.round)).toEqual([600, 300, 300]);
        expect(anyColumnTooTight(pxs)).toBe(true);
        expect(anyColumnTooTight(normalColumnPxs([60, 40], 1000))).toBe(false);
        expect(anyColumnTooTight(normalColumnPxs([40, 60], 1000))).toBe(true);
        expect(anyColumnTooTight([300])).toBe(false);
    });
});

describe("leaving the 360 view (#733)", () => {
    it("leaves at once when every column fits at the current floors", () => {
        // first column at a 900 px floor beside another: 900 + 360 = 1260
        const mins = columnMinimumsPx(2, 900);
        expect(exitView360(mins, 1300)).toEqual({ kind: "leave" });
        expect(exitView360(mins, 1260)).toEqual({ kind: "leave" });
        // Without a floor, the readable minimums.
        expect(exitView360(columnMinimumsPx(2, null), 900)).toEqual({ kind: "leave" });
    });

    it("asks to readjust when the columns fit only once the first column's floor is cleared", () => {
        const mins = columnMinimumsPx(2, 900);
        expect(exitView360(mins, 1259)).toEqual({ kind: "readjust" });
        expect(exitView360(mins, FirstColumnMinPx + SideColumnMinPx)).toEqual({ kind: "readjust" });
        expect(exitView360(mins, FirstColumnMinPx + SideColumnMinPx + 8, 8)).toEqual({ kind: "readjust" });
    });

    it("stays when the columns do not fit even at their readable minimums, saying how many are too many", () => {
        const mins = columnMinimumsPx(2, 900);
        expect(exitView360(mins, FirstColumnMinPx + SideColumnMinPx - 1)).toEqual({
            kind: "blocked",
            extraColumns: 1,
        });
        // Five columns in 1300 px: 520 + 2 x 360 = 1240 fit, so 2 columns are too many.
        const five = columnMinimumsPx(5, null);
        expect(exitView360(five, 1300)).toEqual({ kind: "blocked", extraColumns: 2 });
        expect(exitView360(five, 1300, 4)).toEqual({ kind: "blocked", extraColumns: 2 });
        expect(maxReadableColumns(1300)).toBe(3);
        expect(maxReadableColumns(300)).toBe(1);
    });

    it("leaves a single column or an unmeasured tab without asking", () => {
        expect(exitView360([900], 100)).toEqual({ kind: "leave" });
        expect(exitView360([], 100)).toEqual({ kind: "leave" });
        expect(exitView360([900, 360], 0)).toEqual({ kind: "leave" });
    });

    it("finds the node holding the top-level columns", () => {
        expect(columnsParent(leaf("a"))).toBeNull();
        expect(columnsParent(row(leaf("a"), leaf("b")))?.id).toBe("root");
        expect(
            columnsParent({ id: "w", flexDirection: FlexDirection.Column, size: 10, children: [row(leaf("a"))] })
        ).toBeNull();
    });

    it("shares the width again, raising a column whose minimum is above its share", () => {
        const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
        const equal = sharedColumnSizes([FirstColumnMinPx, SideColumnMinPx], 1600);
        expect(equal).toEqual([50, 50]);
        // Three columns in 1300 px: the first needs 520, the two others share the remaining 780.
        const raised = sharedColumnSizes([FirstColumnMinPx, SideColumnMinPx, SideColumnMinPx], 1300);
        expect(raised.map((s) => Math.round(s * 13))).toEqual([520, 390, 390]);
        expect(sum(raised)).toBeCloseTo(100);
        // With gaps, the room is the width less the gaps.
        const gapped = sharedColumnSizes([FirstColumnMinPx, SideColumnMinPx, SideColumnMinPx], 1304, 2);
        expect(gapped.map((s) => Math.round(s * 13))).toEqual([520, 390, 390]);
        // Below the minimums, the sizes follow them.
        const tight = sharedColumnSizes([FirstColumnMinPx, SideColumnMinPx], 600);
        expect(tight[0] / tight[1]).toBeCloseTo(FirstColumnMinPx / SideColumnMinPx);
        expect(sharedColumnSizes([], 600)).toEqual([]);
    });
});

describe("first column floor in the 360 decision (#731, #848)", () => {
    it("AC1: counts max(readable minimum, floor) for the first column only, whatever it holds", () => {
        // A terminal in the third column no longer counts the floor: the columns' content is not an input.
        expect(columnMinimumsPx(3, 900)).toEqual([900, SideColumnMinPx, SideColumnMinPx]);
        expect(columnMinimumsPx(3, 200)).toEqual([FirstColumnMinPx, SideColumnMinPx, SideColumnMinPx]);
        expect(columnMinimumsPx(3, null)).toEqual([FirstColumnMinPx, SideColumnMinPx, SideColumnMinPx]);
        expect(columnMinimumsPx(0, 900)).toEqual([]);
    });

    it("enters 360 view when the first column's floor no longer fits", () => {
        // a first column (a browser alone, say) at a 900 px floor beside another column: 900 + 360 = 1260
        const mins = columnMinimumsPx(2, 900);
        expect(minimumsPx(2, 0, mins)).toBe(1260);
        expect(autoWants(false, 2, 1500, 0, mins)).toBe(false);
        expect(autoWants(false, 2, 1259, 0, mins)).toBe(true);
        // Without the floor the same width still fits.
        expect(autoWants(false, 2, 1259)).toBe(false);
        expect(autoWants(true, 2, 1260 + LeaveMarginPx - 1, 0, mins)).toBe(true);
        expect(autoWants(true, 2, 1260 + LeaveMarginPx, 0, mins)).toBe(false);
    });

    it("ignores per-column minimums that do not match the column count", () => {
        expect(minimumsPx(3, 0, [900, 360])).toBe(minimumsPx(3));
    });

    it("finds a column under the floor too tight", () => {
        expect(anyColumnTooTight([800, 700], [900, SideColumnMinPx])).toBe(true);
        expect(anyColumnTooTight([900, 700], [900, SideColumnMinPx])).toBe(false);
    });

    it("tells whether the columns fit at the current floors or only at the readable minimums", () => {
        const mins = columnMinimumsPx(2, 900);
        expect(fitsAtCurrentFloors(mins, 1300)).toBe(true);
        expect(fitsAtCurrentFloors(mins, 1200)).toBe(false);
        expect(fitsAtReadableMinimums(2, 1200)).toBe(true);
        expect(fitsAtReadableMinimums(2, 800)).toBe(false);
        expect(fitsAtCurrentFloors(mins, 1300, 0, LeaveMarginPx)).toBe(false);
        expect(fitsAtReadableMinimums(2, FirstColumnMinPx + SideColumnMinPx + 4, 4)).toBe(true);
        expect(fitsAtCurrentFloors([900], 100)).toBe(true);
        expect(fitsAtReadableMinimums(1, 100)).toBe(true);
    });
});
