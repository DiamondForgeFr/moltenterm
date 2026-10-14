// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { describe, expect, it } from "vitest";
import { columnPin, countBeside, parsePins, partPinnedColumns, withoutPin, withPin, withPinWidth } from "./pin-model";

function leaf(id: string): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size: 10, data: { blockId: `b-${id}` } };
}

function stack(id: string, children: LayoutNode[]): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size: 10, children };
}

describe("parsePins (DS-SHELL-118)", () => {
    it("keeps the valid pins of the tab's meta and drops the rest", () => {
        expect(
            parsePins({
                "b-1": { mode: "beside", px: 360 },
                "b-2": { mode: "stacked" },
                "b-3": { mode: "floating" },
                "b-4": "beside",
                "b-5": { mode: "beside", px: -4 },
            })
        ).toEqual({ "b-1": { mode: "beside", px: 360 }, "b-2": { mode: "stacked" }, "b-5": { mode: "beside" } });
        expect(parsePins(null)).toEqual({});
        expect(parsePins(["b-1"])).toEqual({});
    });
});

describe("partPinnedColumns (FR-SHELL-067)", () => {
    const columns = [leaf("web"), stack("col", [leaf("files"), leaf("preview")]), leaf("companion")];

    it("takes pinned columns off the carpet and keeps the others in the tree's order", () => {
        const { carpet, pinned } = partPinnedColumns(columns, { "b-companion": { mode: "beside" } });
        expect(carpet.map((c) => c.id)).toEqual(["web", "col"]);
        expect(pinned.map((p) => [p.node.id, p.blockId, p.pin.mode])).toEqual([["companion", "b-companion", "beside"]]);
    });

    it("pins a column split vertically as a whole when one of its panels is pinned", () => {
        const { carpet, pinned } = partPinnedColumns(columns, { "b-preview": { mode: "stacked" } });
        expect(carpet.map((c) => c.id)).toEqual(["web", "companion"]);
        expect(pinned[0].node.id).toBe("col");
        expect(columnPin(columns[1], { "b-preview": { mode: "stacked" } }).blockId).toBe("b-preview");
    });

    it("unpinning puts the column back at its place on the carpet", () => {
        const pinned = withPin({}, columns[1], "b-files", "beside");
        expect(partPinnedColumns(columns, pinned).carpet.map((c) => c.id)).toEqual(["web", "companion"]);
        const unpinned = withoutPin(pinned, columns[1]);
        expect(unpinned).toEqual({});
        expect(partPinnedColumns(columns, unpinned).carpet.map((c) => c.id)).toEqual(["web", "col", "companion"]);
    });

    it("keeps one pin per column and drops the pins of closed panels", () => {
        const pins = withPin(
            { "b-preview": { mode: "stacked" }, "b-gone": { mode: "beside" } },
            columns[1],
            "b-files",
            "beside",
            ["b-web", "b-files", "b-preview", "b-companion"]
        );
        expect(pins).toEqual({ "b-files": { mode: "beside" } });
    });

    it("remembers the width given to a pinned column and counts the pins beside", () => {
        const pins = withPinWidth({ "b-web": { mode: "beside" } }, "b-web", 401.6);
        expect(pins["b-web"]).toEqual({ mode: "beside", px: 402 });
        expect(withPinWidth(pins, "b-other", 300)).toBe(pins);
        const parted = partPinnedColumns(columns, { ...pins, "b-companion": { mode: "stacked" } });
        expect(countBeside(parted.pinned)).toBe(1);
    });
});
