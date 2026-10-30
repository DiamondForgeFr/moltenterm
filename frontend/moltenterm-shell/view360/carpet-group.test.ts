// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { describe, expect, it } from "vitest";
import {
    GroupAll,
    groupedPins,
    groupOffered,
    GroupPages,
    groupPinPlan,
    isPageColumn,
    readGroup,
} from "./carpet-group";
import { FixedColumnGapPx, PinnedColumnMinPx } from "./carpet-model";
import { GroupPinOrigin, handPins, parsePins, withPin, type TabPins } from "./pin-model";

// Block ids starting with "p" are pages, the others are not.
const viewOf = (blockId: string) => (blockId.startsWith("p") ? "web" : "integration");

function leaf(blockId: string): LayoutNode {
    return { id: `n-${blockId}`, flexDirection: FlexDirection.Column, size: 10, data: { blockId } };
}

function stack(...blockIds: string[]): LayoutNode {
    return { id: `s-${blockIds.join("-")}`, flexDirection: FlexDirection.Column, size: 10, children: blockIds.map(leaf) };
}

// The width at which one more column fits beside the agent within half of the window.
function besideLimitPx(besideCount: number): number {
    const columns = besideCount + 2;
    return 2 * (columns * PinnedColumnMinPx + (columns - 1) * FixedColumnGapPx);
}

describe("360 on the pages (FR-SHELL-124)", () => {
    it("reads the grouping, all panels by default", () => {
        expect(readGroup("pages")).toBe(GroupPages);
        expect(readGroup(null)).toBe(GroupAll);
        expect(readGroup("terminals")).toBe(GroupAll);
    });

    it("counts a column as a page only when all its panels are pages", () => {
        expect(isPageColumn(leaf("p1"), viewOf)).toBe(true);
        expect(isPageColumn(stack("p1", "p2"), viewOf)).toBe(true);
        expect(isPageColumn(stack("p1", "int"), viewOf)).toBe(false);
        expect(isPageColumn(leaf("int"), viewOf)).toBe(false);
    });

    it("offers the choice with two pages and another panel, not otherwise (AC1)", () => {
        expect(groupOffered([leaf("p1"), leaf("p2"), leaf("int")], {}, viewOf)).toBe(true);
        expect(groupOffered([leaf("p1"), leaf("int")], {}, viewOf)).toBe(false);
        expect(groupOffered([leaf("p1"), leaf("p2"), leaf("p3")], {}, viewOf)).toBe(false);
        expect(groupOffered([leaf("int"), leaf("files")], {}, viewOf)).toBe(false);
    });

    it("leaves a panel the developer pinned out of the condition, and counts the grouping's own pins as free", () => {
        const columns = [leaf("p1"), leaf("p2"), leaf("int")];
        const hand: TabPins = { int: { mode: "beside" } };
        expect(groupOffered(columns, hand, viewOf)).toBe(false);
        const grouped: TabPins = { int: { mode: "beside", by: GroupPinOrigin } };
        expect(groupOffered(columns, grouped, viewOf)).toBe(true);
    });

    it("pins beside the agent at the half-window limit, under it just below (AC2)", () => {
        const columns = [leaf("p1"), leaf("int"), leaf("p2")];
        const limit = besideLimitPx(0);
        expect(groupPinPlan(columns, {}, viewOf, limit)).toEqual([{ blockId: "int", mode: "beside" }]);
        expect(groupPinPlan(columns, {}, viewOf, limit - 1)).toEqual([{ blockId: "int", mode: "stacked" }]);
    });

    it("pins beside while it fits, then under, never refusing, the developer's beside pins counted first", () => {
        const columns = [leaf("p1"), leaf("int"), leaf("files"), leaf("p2")];
        const width = besideLimitPx(1) - 1;
        expect(groupPinPlan(columns, {}, viewOf, width)).toEqual([
            { blockId: "int", mode: "beside" },
            { blockId: "files", mode: "stacked" },
        ]);
        const withHand = [leaf("p1"), leaf("dev"), leaf("int"), leaf("p2")];
        expect(groupPinPlan(withHand, { dev: { mode: "beside" } }, viewOf, width)).toEqual([
            { blockId: "int", mode: "stacked" },
        ]);
        expect(groupPinPlan(columns, {}, viewOf, 600).map((p) => p.mode)).toEqual(["stacked", "stacked"]);
    });

    it("marks the grouping's pins and keeps the developer's untouched (AC4)", () => {
        const columns = [leaf("p1"), leaf("dev"), leaf("int"), leaf("p2"), leaf("p3")];
        const hand: TabPins = { dev: { mode: "stacked", px: 400 } };
        const pages = groupedPins(GroupPages, columns, hand, viewOf, 3000);
        expect(pages).toEqual({
            dev: { mode: "stacked", px: 400 },
            int: { mode: "beside", by: GroupPinOrigin },
        });
        expect(groupedPins(GroupAll, columns, pages, viewOf, 3000)).toEqual(hand);
        expect(handPins(pages)).toEqual(hand);
    });

    it("keeps the mark through the view's meta, and a pin by hand never carries it", () => {
        const pins = parsePins({ int: { mode: "beside", by: "group" }, dev: { mode: "stacked", by: "else" } });
        expect(pins).toEqual({ int: { mode: "beside", by: GroupPinOrigin }, dev: { mode: "stacked" } });
        expect(withPin(pins, leaf("int"), "int", "stacked")).toEqual({ int: { mode: "stacked" }, dev: { mode: "stacked" } });
    });
});
