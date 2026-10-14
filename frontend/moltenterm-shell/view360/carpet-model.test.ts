// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { describe, expect, it } from "vitest";
import {
    CarpetColumnGapPx,
    CarpetMarginPx,
    CarpetPadTopPx,
    CarpetPadXPx,
    CarpetScrubberPx,
    DefaultCarpetColumnPx,
    FixedColumnGapPx,
    FixedMaxShare,
    FixedMinPx,
    MinCarpetColumnPx,
    PinnedColumnMinPx,
    canPinBeside,
    carpetColumnKind,
    carpetColumnRect,
    carpetNodeTransform,
    clampColumnPx,
    clampFixedPx,
    clampScroll,
    columnLeadLeaf,
    computeCarpetLayout,
    defaultCarpetWidthPx,
    fitFixedWidths,
    scrollToRevealColumn,
    splitCarpetColumns,
    visibleCarpetColumnIds,
} from "./carpet-model";

function leaf(id: string): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size: 10, data: { blockId: `b-${id}` } };
}

function group(id: string, flexDirection: FlexDirection, children: LayoutNode[]): LayoutNode {
    return { id, flexDirection, size: 10, children };
}

describe("splitCarpetColumns", () => {
    it("keeps the first column fixed and lays the others on the carpet", () => {
        const root = group("root", FlexDirection.Row, [leaf("term"), leaf("web"), leaf("preview")]);
        const split = splitCarpetColumns(root);
        expect(split.fixed.id).toBe("term");
        expect(split.carpet.map((c) => c.id)).toEqual(["web", "preview"]);
    });

    it("keeps a first column split vertically whole in the fixed zone", () => {
        const first = group("col", FlexDirection.Column, [leaf("project"), leaf("term")]);
        const root = group("root", FlexDirection.Row, [first, leaf("web")]);
        const split = splitCarpetColumns(root);
        expect(split.fixed).toBe(first);
        expect(split.carpet.map((c) => c.id)).toEqual(["web"]);
    });

    it("keeps a carpet column split vertically as one column", () => {
        const second = group("col2", FlexDirection.Column, [leaf("web"), leaf("files")]);
        const root = group("root", FlexDirection.Row, [leaf("term"), second, leaf("preview")]);
        expect(splitCarpetColumns(root).carpet).toEqual([second, root.children[2]]);
    });

    it("makes a lone vertical stack the fixed zone with an empty carpet", () => {
        const root = group("root", FlexDirection.Column, [leaf("project"), leaf("term")]);
        const split = splitCarpetColumns(root);
        expect(split.fixed).toBe(root);
        expect(split.carpet).toEqual([]);
    });

    it("leaves a single panel or an empty tab alone", () => {
        expect(splitCarpetColumns(leaf("term"))).toBeNull();
        expect(splitCarpetColumns(null)).toBeNull();
    });
});

describe("column kind", () => {
    it("takes a split column's kind from its top leaf", () => {
        const column = group("col", FlexDirection.Column, [
            group("row", FlexDirection.Row, [leaf("a"), leaf("b")]),
            leaf("c"),
        ]);
        expect(columnLeadLeaf(column).id).toBe("a");
        expect(columnLeadLeaf(leaf("x")).id).toBe("x");
    });

    it("gives every view a carpet width, terminals included", () => {
        expect(carpetColumnKind("term")).toBe("term");
        expect(carpetColumnKind("")).toBeNull();
        expect(defaultCarpetWidthPx("web")).toBe(720);
        expect(defaultCarpetWidthPx("unknown")).toBe(DefaultCarpetColumnPx);
    });
});

describe("widths", () => {
    it("keeps the fixed zone between 520 px and half of the width", () => {
        expect(clampFixedPx(300, 1600)).toBe(FixedMinPx);
        expect(clampFixedPx(1200, 1600)).toBe(800);
        expect(clampFixedPx(640, 1600)).toBe(640);
    });

    it("lets half of the width win on a narrow window", () => {
        expect(clampFixedPx(700, 900)).toBe(450);
        expect(clampFixedPx(100, 900)).toBe(450);
    });

    it("falls back to the minimum for a missing width", () => {
        expect(clampFixedPx(null, 1600)).toBe(FixedMinPx);
        expect(clampFixedPx(Number.NaN, 1600)).toBe(FixedMinPx);
    });

    it("keeps carpet columns readable and no wider than the carpet", () => {
        expect(clampColumnPx(100, 900)).toBe(MinCarpetColumnPx);
        expect(clampColumnPx(2000, 900)).toBe(900);
        expect(clampColumnPx(null, 900)).toBe(DefaultCarpetColumnPx);
    });
});

describe("computeCarpetLayout", () => {
    const layout = computeCarpetLayout({
        width: 1600,
        height: 900,
        fixedNodeId: "term",
        fixedPx: 600,
        columns: [
            { nodeId: "web", widthPx: 720 },
            { nodeId: "preview", widthPx: 500 },
            { nodeId: "files", widthPx: 400 },
        ],
    });

    it("places the fixed zone on the left at its width, full height", () => {
        expect(layout.fixed).toEqual({ top: 0, left: 0, width: 600, height: 900 });
    });

    it("surrounds the carpet with a margin and reserves its bottom for the scrubber", () => {
        expect(layout.surface).toEqual({
            top: CarpetMarginPx,
            left: 600 + CarpetMarginPx,
            width: 1600 - 600 - 2 * CarpetMarginPx,
            height: 900 - 2 * CarpetMarginPx,
        });
        expect(layout.viewport.left).toBe(layout.surface.left + CarpetPadXPx);
        expect(layout.viewport.top).toBe(layout.surface.top + CarpetPadTopPx);
        expect(layout.viewport.height).toBe(layout.surface.height - CarpetPadTopPx - CarpetScrubberPx);
    });

    it("lays the columns side by side at their widths, separated by a gap", () => {
        expect(layout.columns).toEqual([
            { nodeId: "web", x: 0, width: 720 },
            { nodeId: "preview", x: 720 + CarpetColumnGapPx, width: 500 },
            { nodeId: "files", x: 1220 + 2 * CarpetColumnGapPx, width: 400 },
        ]);
        expect(layout.contentWidth).toBe(1620 + 2 * CarpetColumnGapPx);
        expect(layout.maxScroll).toBe(layout.contentWidth - layout.viewport.width);
    });

    it("draws a column at the carpet's top, full carpet height", () => {
        expect(carpetColumnRect(layout, layout.columns[1])).toEqual({
            top: layout.viewport.top,
            left: layout.viewport.left + 720 + CarpetColumnGapPx,
            width: 500,
            height: layout.viewport.height,
        });
    });

    it("does not scroll when everything fits", () => {
        const small = computeCarpetLayout({
            width: 2400,
            height: 900,
            fixedNodeId: "term",
            fixedPx: 600,
            columns: [{ nodeId: "web", widthPx: 500 }],
        });
        expect(small.maxScroll).toBe(0);
    });
});

describe("scrolling", () => {
    const layout = computeCarpetLayout({
        width: 1600,
        height: 900,
        fixedNodeId: "term",
        fixedPx: 600,
        columns: [
            { nodeId: "a", widthPx: 600 },
            { nodeId: "b", widthPx: 600 },
            { nodeId: "c", widthPx: 600 },
        ],
    });
    const viewWidth = layout.viewport.width;

    it("clamps the scroll position to the carpet's content", () => {
        expect(clampScroll(layout, -40)).toBe(0);
        expect(clampScroll(layout, 1e6)).toBe(layout.maxScroll);
        expect(clampScroll(null, 50)).toBe(0);
    });

    it("lists the columns in view", () => {
        expect(visibleCarpetColumnIds(layout, 0)).toEqual(["a", "b"]);
        expect(visibleCarpetColumnIds(layout, layout.maxScroll)).toEqual(["b", "c"]);
        expect(visibleCarpetColumnIds(null, 0)).toEqual([]);
    });

    it("scrolls just enough to reveal a column", () => {
        const c = layout.columns[2];
        expect(scrollToRevealColumn(layout, "c", 0)).toBe(Math.min(layout.maxScroll, c.x + c.width - viewWidth));
        expect(scrollToRevealColumn(layout, "a", layout.maxScroll)).toBe(0);
        expect(scrollToRevealColumn(layout, "a", 0)).toBe(0);
        expect(scrollToRevealColumn(layout, "fixed", 120)).toBe(120);
    });

    it("moves carpet nodes with the scroll variable and cuts them at the carpet's edges", () => {
        const rect = carpetColumnRect(layout, layout.columns[1]);
        const css = carpetNodeTransform(rect, layout);
        expect(css.transform).toBe(
            `translate3d(calc(${Math.floor(rect.left)}px - var(--mt-carpet-scroll, 0px)), ${Math.floor(rect.top)}px, 0)`
        );
        expect(css.clipPath).toContain(
            `calc(var(--mt-carpet-scroll, 0px) - ${Math.floor(rect.left) - layout.surface.left}px)`
        );
        expect(css.clipPath).toContain(
            `calc(${Math.floor(rect.left) + rect.width - (layout.surface.left + layout.surface.width)}px - var(--mt-carpet-scroll, 0px))`
        );
    });
});

describe("pinned columns (FR-SHELL-067)", () => {
    const base = {
        width: 1700,
        height: 900,
        fixedNodeId: "term",
        fixedPx: 470,
        columns: [{ nodeId: "web", widthPx: 720 }],
    };

    it("draws a column pinned beside as a second fixed column, the grip after it", () => {
        const layout = computeCarpetLayout({ ...base, pins: [{ nodeId: "companion", mode: "beside", widthPx: 360 }] });
        expect(layout.fixedColumns.map((c) => [c.nodeId, c.mode, c.rect.left, c.rect.width])).toEqual([
            ["term", "first", 0, 470],
            ["companion", "beside", 470 + FixedColumnGapPx, 360],
        ]);
        expect(layout.fixed.width).toBe(470 + FixedColumnGapPx + 360);
        expect(layout.surface.left).toBe(layout.fixed.width + CarpetMarginPx);
        expect(layout.columns.map((c) => c.nodeId)).toEqual(["web"]);
    });

    it("stacks a column pinned in the first column under it, at its width", () => {
        const layout = computeCarpetLayout({ ...base, pins: [{ nodeId: "files", mode: "stacked", widthPx: 600 }] });
        const [first, stacked] = layout.fixedColumns;
        expect(first.rect).toEqual({ top: 0, left: 0, width: FixedMinPx, height: (900 - FixedColumnGapPx) / 2 });
        expect(stacked.rect).toEqual({
            top: first.rect.height + FixedColumnGapPx,
            left: 0,
            width: FixedMinPx,
            height: first.rect.height,
        });
        expect(layout.fixed.width).toBe(FixedMinPx);
    });

    it("never lets the fixed zone exceed half of the window", () => {
        for (const width of [700, 1200, 1440, 1660, 2560]) {
            const layout = computeCarpetLayout({
                ...base,
                width,
                fixedPx: 900,
                pins: [
                    { nodeId: "a", mode: "beside", widthPx: 700 },
                    { nodeId: "b", mode: "beside", widthPx: 600 },
                ],
            });
            expect(layout.fixed.width).toBeLessThanOrEqual(width * FixedMaxShare);
        }
    });

    it("shrinks the pinned columns to their minimum before the first column", () => {
        // Half of 1440 is 720, less one gap: 712 for both columns.
        expect(fitFixedWidths(1440, 392, [360])).toEqual([392, 712 - 392]);
        expect(fitFixedWidths(1440, 500, [360])).toEqual([712 - PinnedColumnMinPx, PinnedColumnMinPx]);
        expect(fitFixedWidths(2560, 470, [360])).toEqual([470, 360]);
        // Below every minimum, they share the half in proportion.
        const narrow = fitFixedWidths(1000, 470, [360]);
        expect(narrow[0] + narrow[1] + FixedColumnGapPx).toBeLessThanOrEqual(500);
        expect(narrow[0]).toBe(narrow[1]);
        // Without pins, the first column keeps its own bounds.
        expect(fitFixedWidths(1600, 300, [])).toEqual([clampFixedPx(300, 1600)]);
    });

    it("refuses a pin beside when the fixed columns' minimums cannot fit in half of the window", () => {
        expect(canPinBeside(1440, 0)).toBe(true);
        expect(canPinBeside(1440, 1)).toBe(false);
        expect(canPinBeside(2 * (2 * PinnedColumnMinPx + FixedColumnGapPx), 0)).toBe(true);
        expect(canPinBeside(2 * (2 * PinnedColumnMinPx + FixedColumnGapPx) - 2, 0)).toBe(false);
        expect(canPinBeside(2560, 1)).toBe(true);
        expect(canPinBeside(2560, 2)).toBe(false);
    });
});
