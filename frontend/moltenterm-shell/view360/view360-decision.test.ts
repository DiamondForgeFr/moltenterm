// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { describe, expect, it } from "vitest";
import {
    anyColumnTooTight,
    autoMinColumns,
    AutoMinColumns,
    autoWants,
    carpetSlotWidthsPx,
    columnFractions,
    columnMinimumsPx,
    overThreshold,
    readFractions,
    rememberedFixedPx,
    restoredColumnSizes,
    sameFractions,
    slotFraction,
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

    it("holds a view with an N in 360 view whatever the threshold says (FR-SHELL-123-AC9)", () => {
        const base = { setting: "auto" as const, autoOn: false, columnsOver: false, columnCount: 3 };
        expect(decideView360({ ...base, manual: null, places: 2 })).toMatchObject({ active: true, source: "manual" });
        expect(decideView360({ ...base, manual: false, places: 1 }).active).toBe(true);
        expect(decideView360({ ...base, manual: null, places: null }).active).toBe(false);
        expect(decideView360({ ...base, columnCount: 1, manual: null, places: 2 }).active).toBe(false);
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
            reason: "fit",
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
        // A tab turned off by hand (false) stays off, the readable minimums aside (#1083), unless the columns cannot
        // fit at all.
        expect(decideView360({ ...base, setting: "auto", manual: false })).toEqual({
            active: false,
            wanted: false,
            source: "manual",
        });
        expect(decideView360({ ...base, setting: "auto", manual: false, cannotFit: true })).toEqual({
            active: true,
            wanted: true,
            source: "auto",
            reason: "fit",
        });
        expect(decideView360({ ...base, setting: "always", manual: false, autoOn: false })).toEqual({
            active: false,
            wanted: false,
            source: "manual",
        });
        expect(decideView360({ ...base, setting: "auto", manual: false, autoOn: false }).active).toBe(false);
    });

    it("switches beyond the screen's column threshold, the readable minimums as a safety net (#1083)", () => {
        expect(overThreshold(2, 2)).toBe(false);
        expect(overThreshold(3, 2)).toBe(true);
        expect(overThreshold(3, 3)).toBe(false);
        expect(overThreshold(4, 3)).toBe(true);
        const base = { setting: "auto" as const, manual: null as boolean, autoOn: false };
        // Enters at N + 1, whatever the readable minimums say.
        expect(decideView360({ ...base, columnsOver: true, columnCount: 3 })).toEqual({
            active: true,
            wanted: true,
            source: "auto",
            reason: "columns",
        });
        // Leaves at N or fewer.
        expect(decideView360({ ...base, columnsOver: false, columnCount: 2 }).active).toBe(false);
        // A small window on a large screen: the readable minimums switch earlier.
        expect(decideView360({ ...base, autoOn: true, columnsOver: false, columnCount: 3 })).toMatchObject({
            active: true,
            reason: "fit",
        });
        // Turned off by hand beyond the threshold: stays off.
        expect(decideView360({ ...base, manual: false, columnsOver: true, columnCount: 4 }).active).toBe(false);
        // On demand within the threshold.
        expect(decideView360({ ...base, manual: true, columnsOver: false, columnCount: 2 }).source).toBe("manual");
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

describe("leaving the 360 view (#733, #1083)", () => {
    it("leaves at once whenever the columns fit at their readable minimums, the first column's floor aside", () => {
        expect(exitView360(2, 1300)).toEqual({ kind: "leave" });
        // Below a 900 px floor beside another column (900 + 360 = 1260): no "readjust" step any more.
        expect(exitView360(2, 1259)).toEqual({ kind: "leave" });
        expect(exitView360(2, FirstColumnMinPx + SideColumnMinPx)).toEqual({ kind: "leave" });
        expect(exitView360(2, FirstColumnMinPx + SideColumnMinPx + 8, 8)).toEqual({ kind: "leave" });
    });

    it("stays when the columns do not fit even at their readable minimums, saying how many are too many", () => {
        expect(exitView360(2, FirstColumnMinPx + SideColumnMinPx - 1)).toEqual({
            kind: "blocked",
            extraColumns: 1,
        });
        // Five columns in 1300 px: 520 + 2 x 360 = 1240 fit, so 2 columns are too many.
        expect(exitView360(5, 1300)).toEqual({ kind: "blocked", extraColumns: 2 });
        expect(exitView360(5, 1300, 4)).toEqual({ kind: "blocked", extraColumns: 2 });
        expect(maxReadableColumns(1300)).toBe(3);
        expect(maxReadableColumns(300)).toBe(1);
    });

    it("leaves a single column or an unmeasured tab without asking", () => {
        expect(exitView360(1, 100)).toEqual({ kind: "leave" });
        expect(exitView360(0, 100)).toEqual({ kind: "leave" });
        expect(exitView360(2, 0)).toEqual({ kind: "leave" });
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
        // a first column at a 900 px floor beside two others: 900 + 360 + 360 = 1620
        const mins = columnMinimumsPx(3, 900);
        expect(minimumsPx(3, 0, mins)).toBe(1620);
        expect(autoWants(false, 3, 1700, 0, mins)).toBe(false);
        expect(autoWants(false, 3, 1619, 0, mins)).toBe(true);
        // Without the floor the same width still fits.
        expect(autoWants(false, 3, 1619)).toBe(false);
        expect(autoWants(true, 3, 1620 + LeaveMarginPx - 1, 0, mins)).toBe(true);
        expect(autoWants(true, 3, 1620 + LeaveMarginPx, 0, mins)).toBe(false);
    });

    it("#1225: two columns never go automatic, whatever the floor or the width", () => {
        // The case that tripped: a wide first column floor beside a single other column on a laptop.
        const mins = columnMinimumsPx(2, 900);
        for (const width of [200, 800, 1000, 1259, 1260, 1500, 3000]) {
            expect(autoWants(false, 2, width, 0, mins)).toBe(false);
            expect(autoWants(true, 2, width, 0, mins)).toBe(false);
            expect(autoWants(false, 2, width)).toBe(false);
        }
        const base = { setting: "auto" as const, manual: null as boolean, columnCount: 2 };
        expect(decideView360({ ...base, autoOn: true, columnsOver: true, cannotFit: true })).toMatchObject({
            active: false,
            wanted: false,
        });
        expect(decideView360({ ...base, manual: false, autoOn: true, cannotFit: true }).active).toBe(false);
    });

    it("FR-SHELL-109: in a narrow window two columns go automatic when they cannot fit, never a single one", () => {
        const two = {
            setting: "auto" as const,
            manual: null as boolean,
            autoOn: false,
            columnCount: 2,
            narrowWindow: true,
        };
        expect(autoMinColumns(true)).toBe(2);
        expect(autoMinColumns(false)).toBe(AutoMinColumns);
        expect(autoWants(false, 2, 800, 0, undefined, autoMinColumns(true))).toBe(true);
        expect(autoWants(false, 2, 900, 0, undefined, autoMinColumns(true))).toBe(false);
        // The leaving margin holds it on until the columns fit with room to spare.
        expect(autoWants(true, 2, 900, 0, undefined, autoMinColumns(true))).toBe(true);
        expect(autoWants(true, 2, 880 + LeaveMarginPx, 0, undefined, autoMinColumns(true))).toBe(false);
        expect(decideView360({ ...two, autoOn: true })).toMatchObject({ active: true, source: "auto", reason: "fit" });
        expect(decideView360({ ...two, manual: false, cannotFit: true })).toMatchObject({ active: true });
        expect(decideView360({ ...two, autoOn: false })).toMatchObject({ active: false });
        expect(decideView360({ ...two, autoOn: true, narrowWindow: false })).toMatchObject({ active: false });
        expect(decideView360({ ...two, columnCount: 1, autoOn: true }).active).toBe(false);
        // The screen's column threshold still starts at three columns.
        expect(decideView360({ ...two, columnsOver: true }).active).toBe(false);
    });

    it("#1225: on demand and the always setting keep two columns", () => {
        const two = { autoOn: false, columnCount: 2 };
        expect(decideView360({ ...two, setting: "auto", manual: true })).toMatchObject({
            active: true,
            source: "manual",
        });
        expect(decideView360({ ...two, setting: "always", manual: null })).toMatchObject({
            active: true,
            source: "setting",
        });
    });

    it("#1225: three columns go automatic over the threshold or when they do not fit", () => {
        const three = { setting: "auto" as const, manual: null as boolean, columnCount: 3 };
        expect(decideView360({ ...three, autoOn: false, columnsOver: true })).toMatchObject({
            active: true,
            reason: "columns",
        });
        expect(decideView360({ ...three, autoOn: true })).toMatchObject({ active: true, reason: "fit" });
        expect(decideView360({ ...three, autoOn: false, columnsOver: false }).active).toBe(false);
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

describe("the developer's proportions (#1083)", () => {
    it("reads the columns' shares and compares them within rounding", () => {
        expect(columnFractions([40, 60])).toEqual([0.4, 0.6]);
        expect(columnFractions([1, 1, 2])).toEqual([0.25, 0.25, 0.5]);
        expect(columnFractions([10, 0])).toEqual([]);
        expect(columnFractions([])).toEqual([]);
        expect(sameFractions([0.4, 0.6], [0.4002, 0.5998])).toBe(true);
        expect(sameFractions([0.4, 0.6], [0.41, 0.59])).toBe(false);
        expect(sameFractions([0.4, 0.6], [0.4, 0.3, 0.3])).toBe(false);
        expect(readFractions([30, 35, 35])).toEqual([0.3, 0.35, 0.35]);
        expect(readFractions("bogus")).toBeNull();
        expect(readFractions([0.5, "x"])).toBeNull();
        expect(readFractions([])).toBeNull();
    });

    it("gives the columns back their proportions on leaving, a column past them at the slot's share", () => {
        // Laptop 40/60, a third panel opened then closed: 40/60 again, whatever the tree's sizes became.
        expect(restoredColumnSizes([0.4, 0.6], 2)).toEqual([40, 60]);
        // Wide 30/35/35 with one column fewer: the shares kept, scaled to what is left.
        expect(restoredColumnSizes([0.3, 0.35, 0.35], 2).map((s) => Math.round(s * 100) / 100)).toEqual([
            46.15, 53.85,
        ]);
        // More columns than remembered (another screen, a lower threshold): the slot's share for each.
        expect(restoredColumnSizes([0.4, 0.6], 3).map((s) => Math.round(s * 100) / 100)).toEqual([25, 37.5, 37.5]);
        expect(restoredColumnSizes(null, 2)).toBeNull();
        expect(restoredColumnSizes([1], 2)).toBeNull();
        expect(slotFraction([0.3, 0.35, 0.35], 5)).toBe(0.35);
        expect(slotFraction([1], 0)).toBe(1);
        expect(slotFraction([1], 1)).toBeNull();
    });

    it("keeps the first column's share for the fixed zone and the others' shares on the carpet", () => {
        // 1600 px, 40/60: the fixed zone at 640 px.
        expect(rememberedFixedPx([0.4, 0.6], 1600)).toBe(640);
        expect(rememberedFixedPx([0.4, 0.6], 1604, 4)).toBe(640);
        expect(rememberedFixedPx([1], 1600)).toBeNull();
        // Laptop 40/60: one carpet panel visible at the whole carpet, every new one the same slot.
        expect(carpetSlotWidthsPx([0.4, 0.6], [1, 2, 3], 900, 12)).toEqual([900, 900, 900]);
        // Wide 30/35/35: two carpet panels side by side, a fourth column at the same slot.
        expect(carpetSlotWidthsPx([0.3, 0.35, 0.35], [1, 2, 3], 1812, 12)).toEqual([900, 900, 900]);
        // Uneven 20/30/50: the carpet panels keep their ratio.
        const uneven = carpetSlotWidthsPx([0.2, 0.3, 0.5], [1, 2], 1000, 0);
        expect(uneven.map(Math.round)).toEqual([375, 625]);
        expect(carpetSlotWidthsPx([1], [1], 900)).toBeNull();
        expect(carpetSlotWidthsPx(null, [1], 900)).toBeNull();
    });
});
