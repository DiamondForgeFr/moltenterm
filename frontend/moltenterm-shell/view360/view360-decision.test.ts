// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { describe, expect, it } from "vitest";
import {
    anyColumnTooTight,
    autoWants,
    columnMinimumsPx,
    countLeaves,
    decideView360,
    FirstColumnMinPx,
    fitsAtCurrentFloors,
    fitsAtReadableMinimums,
    LeaveMarginPx,
    manualChoice,
    minimumsPx,
    normalColumnPxs,
    normalizeView360Setting,
    showTightPill,
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
        expect(normalizeView360Setting("never")).toBe("never");
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

    it("follows the setting, and a manual choice wins over every mode", () => {
        const base = { autoOn: true, columnCount: 3 };
        expect(decideView360({ ...base, setting: "auto", manual: null })).toEqual({
            active: true,
            wanted: true,
            source: "auto",
        });
        expect(decideView360({ ...base, setting: "auto", manual: null, autoOn: false }).active).toBe(false);
        expect(decideView360({ ...base, setting: "always", manual: null, autoOn: false }).active).toBe(true);
        expect(decideView360({ ...base, setting: "never", manual: null }).active).toBe(false);
        expect(decideView360({ ...base, setting: "auto", manual: false })).toEqual({
            active: false,
            wanted: false,
            source: "manual",
        });
        expect(decideView360({ ...base, setting: "never", manual: true }).active).toBe(true);
        expect(decideView360({ ...base, setting: "always", manual: false }).active).toBe(false);
    });

    it("measures the normal columns and finds the one too tight to read", () => {
        const pxs = normalColumnPxs([50, 25, 25], 1204, 2);
        expect(pxs.map(Math.round)).toEqual([600, 300, 300]);
        expect(anyColumnTooTight(pxs)).toBe(true);
        expect(anyColumnTooTight(normalColumnPxs([60, 40], 1000))).toBe(false);
        expect(anyColumnTooTight(normalColumnPxs([40, 60], 1000))).toBe(true);
        expect(anyColumnTooTight([300])).toBe(false);
    });

    it("shows the pill only when the 360 view was refused and a column is too tight", () => {
        const base = { active: false, tooTight: true, dismissed: false };
        expect(showTightPill({ ...base, setting: "never", manual: null })).toBe(true);
        expect(showTightPill({ ...base, setting: "auto", manual: false })).toBe(true);
        expect(showTightPill({ ...base, setting: "auto", manual: null })).toBe(false);
        expect(showTightPill({ ...base, setting: "never", manual: null, dismissed: true })).toBe(false);
        expect(showTightPill({ ...base, setting: "never", manual: null, tooTight: false })).toBe(false);
        expect(showTightPill({ ...base, setting: "never", manual: true, active: true })).toBe(false);
    });
});

describe("terminal floor in the 360 decision (#731)", () => {
    const isTerm = (n: LayoutNode) => n.data?.blockId?.startsWith("b-t") ?? false;

    it("counts max(readable minimum, floor) for a terminal column, the readable minimum for the others", () => {
        const cols = [leaf("t1"), leaf("browser"), leaf("t2")];
        expect(columnMinimumsPx(cols, 900, isTerm)).toEqual([900, SideColumnMinPx, 900]);
        expect(columnMinimumsPx(cols, 200, isTerm)).toEqual([FirstColumnMinPx, SideColumnMinPx, SideColumnMinPx]);
        expect(columnMinimumsPx(cols, null, isTerm)).toEqual([FirstColumnMinPx, SideColumnMinPx, SideColumnMinPx]);
    });

    it("adds the floors of terminals side by side in a column and keeps the largest of stacked ones", () => {
        const stacked: LayoutNode = {
            id: "s",
            flexDirection: FlexDirection.Column,
            size: 10,
            children: [leaf("t1"), leaf("x")],
        };
        const sideBySide: LayoutNode = {
            id: "r",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("t2"), leaf("t3"), leaf("y")],
        };
        expect(columnMinimumsPx([stacked, sideBySide], 600, isTerm)).toEqual([600, 1200]);
    });

    it("enters 360 view when the floor of a terminal column no longer fits", () => {
        // terminal at a 900 px floor beside a browser: 900 + 360 = 1260
        const mins = columnMinimumsPx([leaf("t1"), leaf("browser")], 900, isTerm);
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
        const mins = columnMinimumsPx([leaf("t1"), leaf("browser")], 900, isTerm);
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
