// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { describe, expect, it } from "vitest";
import {
    anyColumnTooTight,
    autoWants,
    decideView360,
    FirstColumnMinPx,
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
