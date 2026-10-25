// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { splitHorizontal } from "@/layout/lib/layoutTree";
import { FlexDirection, LayoutTreeActionType, type LayoutNode, type LayoutTreeState } from "@/layout/lib/types";
import { describe, expect, it } from "vitest";
import {
    CarpetColumnGapPx,
    CarpetEndReservePx,
    CarpetInvitePx,
    CarpetMarginPx,
    CarpetPadTopPx,
    CarpetPadXPx,
    CarpetReservePx,
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
    carpetInsertPlace,
    carpetNodeTransform,
    carpetPanelRoomPx,
    carpetScrollStops,
    carpetSplitPlace,
    clampColumnPx,
    clampFixedDragPx,
    clampFixedPx,
    clampScroll,
    columnLeadLeaf,
    computeCarpetLayout,
    defaultCarpetWidthPx,
    fitFixedWidths,
    fixedBoundsPx,
    fixedCapPx,
    fixedDragBoundsPx,
    scrollToRevealColumn,
    sideColumnBoundsPx,
    splitCarpetColumns,
    visibleCarpetColumnIds,
} from "./carpet-model";

// Where the first carpet column starts: after the start invitation and a gap (#702).
const Lead = CarpetInvitePx + CarpetColumnGapPx;

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

describe("carpetSplitPlace (#677)", () => {
    // Runs the placed split through Wave's own reducer and reads the carpet order back.
    function carpetAfter(root: LayoutNode, targetNodeId: string, position: "before" | "after"): string[] {
        const place = carpetSplitPlace(root, targetNodeId, position);
        const state = { rootNode: root } as LayoutTreeState;
        splitHorizontal(state, {
            type: LayoutTreeActionType.SplitHorizontal,
            targetNodeId: place.targetNodeId,
            newNode: leaf("new"),
            position: place.position,
        });
        return splitCarpetColumns(state.rootNode).carpet.map((c) => c.id);
    }

    function tab(): LayoutNode {
        const stack = group("stack", FlexDirection.Column, [leaf("s1"), leaf("s2")]);
        return group("root", FlexDirection.Row, [leaf("term"), leaf("web"), stack, leaf("preview")]);
    }

    it("puts a left split before its panel on the carpet, a right split after it", () => {
        expect(carpetAfter(tab(), "web", "before")).toEqual(["new", "web", "stack", "preview"]);
        expect(carpetAfter(tab(), "web", "after")).toEqual(["web", "new", "stack", "preview"]);
        expect(carpetAfter(tab(), "preview", "before")).toEqual(["web", "stack", "new", "preview"]);
    });

    it("places beside the whole column of a panel stacked in it", () => {
        expect(carpetAfter(tab(), "s2", "before")).toEqual(["web", "new", "stack", "preview"]);
        expect(carpetAfter(tab(), "s1", "after")).toEqual(["web", "stack", "new", "preview"]);
    });

    it("keeps the fixed zone's panel: a split from it opens the carpet", () => {
        expect(carpetAfter(tab(), "term", "before")).toEqual(["new", "web", "stack", "preview"]);
        expect(carpetAfter(tab(), "term", "after")).toEqual(["new", "web", "stack", "preview"]);
        expect(splitCarpetColumns(tab()).fixed.id).toBe("term");
    });

    it("wraps a lone panel with the new one after it, and sends an unknown source to the end", () => {
        expect(carpetSplitPlace(leaf("only"), "only", "before")).toEqual({ targetNodeId: "only", position: "after" });
        expect(carpetSplitPlace(tab(), "nowhere", "before")).toEqual({ targetNodeId: "preview", position: "after" });
    });
});

describe("carpetInsertPlace (#702)", () => {
    function tab(): LayoutNode {
        const stack = group("stack", FlexDirection.Column, [leaf("s1"), leaf("s2")]);
        return group("root", FlexDirection.Row, [leaf("term"), leaf("pinned"), leaf("web"), stack, leaf("preview")]);
    }

    function layoutOf(root: LayoutNode, carpetIds: string[]) {
        return computeCarpetLayout({
            width: 1600,
            height: 900,
            fixedNodeId: root.children?.[0]?.id ?? root.id,
            fixedPx: 600,
            columns: carpetIds.map((nodeId) => ({ nodeId, widthPx: 600 })),
        });
    }

    // Runs the insertion through Wave's own reducer, then 360 view's own placement of splits, and reads the carpet back.
    function carpetAfter(root: LayoutNode, carpetIds: string[], end: "start" | "end"): string[] {
        const place = carpetInsertPlace(root, layoutOf(root, carpetIds), end);
        const laid = carpetSplitPlace(root, place.targetNodeId, place.position);
        const state = { rootNode: root } as LayoutTreeState;
        splitHorizontal(state, {
            type: LayoutTreeActionType.SplitHorizontal,
            targetNodeId: laid.targetNodeId,
            newNode: leaf("new"),
            position: laid.position,
        });
        return splitCarpetColumns(state.rootNode).carpet.map((c) => c.id);
    }

    it("adds a column before the first carpet column, after the pinned ones", () => {
        expect(carpetAfter(tab(), ["web", "stack", "preview"], "start")).toEqual([
            "pinned",
            "new",
            "web",
            "stack",
            "preview",
        ]);
    });

    it("adds a column after the last carpet column", () => {
        expect(carpetAfter(tab(), ["web", "stack", "preview"], "end")).toEqual([
            "pinned",
            "web",
            "stack",
            "preview",
            "new",
        ]);
    });

    it("keeps offering both ends after each addition", () => {
        let root = tab();
        const state = { rootNode: root } as LayoutTreeState;
        for (const end of ["end", "end", "start", "start"] as const) {
            const carpet = splitCarpetColumns(state.rootNode)
                .carpet.map((c) => c.id)
                .filter((id) => id !== "pinned");
            const layout = layoutOf(state.rootNode, carpet);
            expect(layout.invites.map((i) => i.end)).toEqual(["start", "end"]);
            const place = carpetInsertPlace(state.rootNode, layout, end);
            splitHorizontal(state, {
                type: LayoutTreeActionType.SplitHorizontal,
                targetNodeId: place.targetNodeId,
                newNode: leaf(`${end}-${carpet.length}`),
                position: place.position,
            });
        }
        root = state.rootNode;
        expect(splitCarpetColumns(root).carpet.map((c) => c.id)).toEqual([
            "pinned",
            "start-6",
            "start-5",
            "web",
            "stack",
            "preview",
            "end-3",
            "end-4",
        ]);
    });

    it("adds after the root's last column on an empty carpet, and wraps a lone stack", () => {
        expect(carpetInsertPlace(tab(), layoutOf(tab(), []), "start")).toEqual({
            targetNodeId: "preview",
            position: "after",
        });
        const stack = group("stack", FlexDirection.Column, [leaf("a"), leaf("b")]);
        expect(carpetInsertPlace(stack, layoutOf(stack, []), "end")).toEqual({
            targetNodeId: "stack",
            position: "after",
        });
        expect(carpetInsertPlace(null, null, "end")).toBeNull();
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

    it("keeps a real range on a window under twice the minimum (#829)", () => {
        // 1000 px: 520 px fits under what leaves the carpet its reserve (600 px).
        expect(fixedBoundsPx(1000)).toEqual({ min: FixedMinPx, max: 1000 - CarpetReservePx });
        // 900 px: 520 px does not fit under 500 px, half of the window is the minimum.
        expect(fixedBoundsPx(900)).toEqual({ min: 450, max: 500 });
        expect(clampFixedPx(700, 900)).toBe(500);
        expect(clampFixedPx(100, 900)).toBe(450);
        expect(clampFixedPx(480, 900)).toBe(480);
    });

    it("keeps the wide window's bounds", () => {
        expect(fixedBoundsPx(1600)).toEqual({ min: FixedMinPx, max: 800 });
        expect(fixedBoundsPx(2560)).toEqual({ min: FixedMinPx, max: 1280 });
        expect(fixedBoundsPx(1600).noRoom).toBeUndefined();
    });

    it("lets a terminal floor above half widen the zone up to the carpet's reserve (#733, #829)", () => {
        expect(CarpetReservePx).toBe(360 + 2 * CarpetPadXPx + 2 * CarpetMarginPx);
        // 1499 px floor in a 2000 px window: the floor is the minimum, the carpet's reserve the maximum.
        expect(fixedBoundsPx(2000, 1499)).toEqual({ min: 1499, max: 2000 - CarpetReservePx });
        expect(clampFixedPx(974, 2000, 1499)).toBe(1499);
        expect(clampFixedPx(1550, 2000, 1499)).toBe(1550);
        expect(clampFixedPx(1700, 2000, 1499)).toBe(2000 - CarpetReservePx);
        // A laptop window with a floor past half: 1280 px, 700 px floor.
        expect(fixedBoundsPx(1280, 700)).toEqual({ min: 700, max: 1280 - CarpetReservePx });
        // One pixel short of the floor plus the reserve: the floor gives way, half of the window is the minimum.
        expect(fixedBoundsPx(1498 + CarpetReservePx, 1499)).toEqual({ min: 949, max: 1498 });
        // A floor under half of the window only lifts the minimum.
        expect(fixedBoundsPx(1600, 700)).toEqual({ min: 700, max: 800 });
        expect(fixedBoundsPx(1600, 0)).toEqual(fixedBoundsPx(1600));
    });

    it("says why when the window leaves no room (#829)", () => {
        // The floor plus the carpet's reserve fill the window exactly.
        expect(fixedBoundsPx(1499 + CarpetReservePx, 1499)).toEqual({ min: 1499, max: 1499, noRoom: "floor" });
        // Under twice the carpet's reserve, half of the window is all there is.
        expect(fixedBoundsPx(2 * CarpetReservePx)).toEqual({ min: 400, max: 400, noRoom: "window" });
        expect(fixedBoundsPx(600)).toEqual({ min: 300, max: 300, noRoom: "window" });
        expect(clampFixedPx(500, 600)).toBe(300);
    });

    it("lets the grip narrow below the first column's floor, which it sets, and keeps the cap the floor lifts (#848)", () => {
        // 1280 px window, 700 px floor: the grip ranges from the zone's minimum to the carpet's reserve.
        expect(fixedDragBoundsPx(1280, 700)).toEqual({ min: FixedMinPx, max: 1280 - CarpetReservePx });
        expect(clampFixedDragPx(300, 1280, 700)).toBe(FixedMinPx);
        expect(clampFixedDragPx(1200, 1280, 700)).toBe(1280 - CarpetReservePx);
        // A floor under half of the window leaves half as the cap.
        expect(fixedDragBoundsPx(1600, 700)).toEqual({ min: FixedMinPx, max: 800 });
        expect(fixedDragBoundsPx(1600)).toEqual({ min: FixedMinPx, max: 800 });
        // A window that leaves no room says so.
        expect(fixedDragBoundsPx(600)).toEqual({ min: 300, max: 300, noRoom: "window" });
    });

    it("gives a fixed column side by side what the others leave, or says it has no room (#829)", () => {
        // Half of 1440 is 720: with 392 px taken by the others, the column ranges from 320 to 328 px.
        expect(sideColumnBoundsPx(1440, 0, 392)).toEqual({ min: PinnedColumnMinPx, max: 328 });
        expect(sideColumnBoundsPx(1440, 0, 400)).toEqual({
            min: PinnedColumnMinPx,
            max: PinnedColumnMinPx,
            noRoom: "columns",
        });
        expect(fixedCapPx(1440)).toBe(720);
        expect(fixedCapPx(2000, 1100)).toBe(1100);
    });

    it("gives the first column's terminal floor what pinned columns leave at their minimum (#733)", () => {
        // 1100 px floor in 2000 px: the fixed zone may take 1100 px, less one gap for both columns.
        const widths = fitFixedWidths(2000, 500, [400], 1100);
        expect(widths[0]).toBe(1100 - FixedColumnGapPx - PinnedColumnMinPx);
        expect(widths[1]).toBe(PinnedColumnMinPx);
        const layout = computeCarpetLayout({
            width: 2000,
            height: 900,
            fixedNodeId: "a",
            fixedPx: 500,
            fixedNeedPx: 1100,
            columns: [{ nodeId: "b", widthPx: 600 }],
        });
        expect(layout.fixed.width).toBe(1100);
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

    it("lays the columns side by side at their widths, separated by a gap, after the start invitation", () => {
        expect(layout.columns).toEqual([
            { nodeId: "web", x: Lead, width: 720 },
            { nodeId: "preview", x: Lead + 720 + CarpetColumnGapPx, width: 500 },
            { nodeId: "files", x: Lead + 1220 + 2 * CarpetColumnGapPx, width: 400 },
        ]);
        // Free widths do not add up to the carpet's: the last position is the last panel's edge, with empty room after
        // the end invitation rather than a cut panel (#1131).
        expect(layout.maxScroll).toBe(layout.columns[2].x);
        expect(layout.maxScroll).toBeGreaterThan(layout.contentWidth - layout.viewport.width);
    });

    it("leaves room for the end invitation beside a panel as wide as the carpet (#1131)", () => {
        const wide = computeCarpetLayout({
            width: 1600,
            height: 900,
            fixedNodeId: "term",
            fixedPx: 600,
            columns: [
                { nodeId: "a", widthPx: 5000 },
                { nodeId: "b", widthPx: 5000 },
            ],
        });
        const room = carpetPanelRoomPx(wide.viewport.width);
        expect(room).toBe(wide.viewport.width - CarpetEndReservePx);
        expect(wide.columns.map((c) => c.width)).toEqual([room, room]);
        expect(wide.maxScroll).toBe(wide.columns[1].x);
        expect(carpetScrollStops(wide)).toEqual([0, wide.columns[0].x, wide.columns[1].x]);
    });

    it("lays an invitation to add a panel at each end of the carpet (#702)", () => {
        const end = Lead + 1620 + 3 * CarpetColumnGapPx;
        expect(layout.invites).toEqual([
            { end: "start", x: 0, width: CarpetInvitePx },
            { end: "end", x: end, width: CarpetInvitePx },
        ]);
        expect(layout.contentWidth).toBe(end + CarpetInvitePx);
    });

    it("keeps a single invitation on an empty carpet", () => {
        const empty = computeCarpetLayout({ width: 1600, height: 900, fixedNodeId: "term", fixedPx: 600, columns: [] });
        expect(empty.invites).toEqual([{ end: "end", x: 0, width: CarpetInvitePx }]);
        expect(empty.contentWidth).toBe(CarpetInvitePx);
        expect(empty.maxScroll).toBe(0);
    });

    it("draws a column at the carpet's top, full carpet height", () => {
        expect(carpetColumnRect(layout, layout.columns[1])).toEqual({
            top: layout.viewport.top,
            left: layout.viewport.left + Lead + 720 + CarpetColumnGapPx,
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
        expect(visibleCarpetColumnIds(layout, layout.maxScroll)).toEqual(["c"]);
        expect(visibleCarpetColumnIds(null, 0)).toEqual([]);
    });

    it("reveals a column at the nearest snap position showing it whole (#1131)", () => {
        const b = layout.columns[1];
        expect(carpetScrollStops(layout)).toEqual([0, layout.columns[0].x, b.x, layout.columns[2].x]);
        expect(scrollToRevealColumn(layout, "b", 0)).toBe(b.x);
        expect(scrollToRevealColumn(layout, "b", layout.maxScroll)).toBe(b.x);
        // Already whole in view: the carpet stays.
        expect(scrollToRevealColumn(layout, "b", b.x + b.width - viewWidth)).toBe(b.x + b.width - viewWidth);
        expect(scrollToRevealColumn(layout, "a", 0)).toBe(0);
        expect(scrollToRevealColumn(layout, "fixed", 120)).toBe(120);
    });

    it("brings an end's invitation along with the first or last column (#702)", () => {
        expect(scrollToRevealColumn(layout, "c", 0)).toBe(layout.maxScroll);
        expect(scrollToRevealColumn(layout, "a", layout.maxScroll)).toBe(0);
        // A last column wider than the carpet is narrowed to leave its invitation room (#1131).
        const wide = computeCarpetLayout({
            width: 1600,
            height: 900,
            fixedNodeId: "term",
            fixedPx: 600,
            columns: [
                { nodeId: "a", widthPx: 600 },
                { nodeId: "z", widthPx: 5000 },
            ],
        });
        const z = wide.columns[1];
        expect(scrollToRevealColumn(wide, "z", 0)).toBe(z.x);
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
