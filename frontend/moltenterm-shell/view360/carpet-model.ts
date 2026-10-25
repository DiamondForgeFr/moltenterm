// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// 360 view (FR-SHELL-065, DS-SHELL-114/115): a workspace tab drawn as a fixed zone on the left, holding the tab's
// first column, and a carpet that scrolls horizontally with every other column laid on it at the width remembered for
// its kind. A presentation of the same layout tree: these rules never change the tree, only where its columns are
// drawn. Kept apart from the layout so they are tested alone.

import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { LegacyTimelineView, MoltentermProjectView } from "../project/project-model";

// The fixed zone keeps this width at least, and never more than half of the tab's width (half wins on a narrow
// window: the carpet must stay usable). The first column's floor lifts both while a carpet column still fits (fixedBoundsPx),
// and a minimum above half lets the zone grow up to what leaves the carpet one readable column (#829).
export const FixedMinPx = 520;
export const FixedMaxShare = 0.5;
// Room around the carpet surface, so it reads as a recessed area beside the fixed zone.
export const CarpetMarginPx = 8;
// Room between the carpet surface's edges and the panels laid on it; the top one holds the "carpet" label.
export const CarpetPadXPx = 12;
export const CarpetPadTopPx = 16;
// The bottom of the carpet is reserved for its radar scrubber (#617): the pill of the ticks in view and some air.
export const CarpetScrubberPx = 32;
export const CarpetColumnGapPx = 12;
export const MinCarpetColumnPx = 280;
export const DefaultCarpetColumnPx = 560;
// With a column pinned beside it (FR-SHELL-067), every fixed column (the first one included) keeps this width at
// least, so a terminal and a side panel fit side by side in half of a laptop's window. Fixed columns are separated
// by the carpet's margin.
export const PinnedColumnMinPx = 320;
export const FixedColumnGapPx = CarpetMarginPx;
// The "add a panel" invitation laid at each end of the carpet (#702): a slim column, a column gap from its neighbour.
export const CarpetInvitePx = 44;
// The room one invitation takes with its gap. Panels share the carpet's width minus this room, so the first position
// (start invitation + panels) and the last one (panels + end invitation) show whole panels (#1131).
export const CarpetEndReservePx = CarpetInvitePx + CarpetColumnGapPx;
// Below this, two scroll positions are the same panel edge (slots from proportions are fractional).
const EdgeEpsilonPx = 0.5;
// The readable minimum of a column other than the first (FR-SHELL-066's automatic decision counts it too).
export const ReadableCarpetColumnPx = 360;
// What the carpet needs to show one column at its readable minimum: the column, the carpet's padding and margins.
export const CarpetReservePx = ReadableCarpetColumnPx + 2 * CarpetPadXPx + 2 * CarpetMarginPx;

// The width a column takes on the carpet when none is remembered for its kind.
const DefaultCarpetWidths: Record<string, number> = {
    term: 640,
    web: 720,
    preview: 600,
    [MoltentermProjectView]: 480,
    [LegacyTimelineView]: 480,
};

export type Rect = { top: number; left: number; width: number; height: number };

export type CarpetColumns = {
    // The tab's first column: the first top-level child of a row, or the whole tree when it is a single vertical stack.
    fixed: LayoutNode;
    // The other top-level columns, left to right; a column split vertically stays one column.
    carpet: LayoutNode[];
};

export type CarpetColumn = {
    nodeId: string;
    // Offset from the start of the carpet's content, before scrolling.
    x: number;
    width: number;
};

// An end of the carpet: "start" right after the fixed zone, "end" after the last column.
export type CarpetEnd = "start" | "end";

// The invitation to add a panel at one end of the carpet (#702), laid on the carpet's content like a column.
export type CarpetInvite = {
    end: CarpetEnd;
    x: number;
    width: number;
};

// A carpet column pinned to the fixed zone (FR-SHELL-067): a second fixed column beside the first, or stacked under it.
export type PinMode = "beside" | "stacked";

export type FixedColumn = {
    nodeId: string;
    // "first" is the tab's first column; the others are pinned columns.
    mode: "first" | PinMode;
    rect: Rect;
};

export type CarpetLayout = {
    fixedNodeId: string;
    // The whole fixed zone: the first column, with the columns pinned beside it.
    fixed: Rect;
    // The fixed zone's columns: the first one, then the pinned ones in the tree's order.
    fixedColumns: FixedColumn[];
    // The recessed surface, and inside it the band the columns are laid in.
    surface: Rect;
    viewport: Rect;
    columns: CarpetColumn[];
    // Before the first column and after the last one; a single "end" one on an empty carpet.
    invites: CarpetInvite[];
    contentWidth: number;
    maxScroll: number;
};

export type CarpetLayoutInput = {
    width: number;
    height: number;
    fixedNodeId: string;
    // The fixed zone's chosen width (dragged, or the first column's normal width the first time).
    fixedPx: number;
    // The columns left on the carpet, left to right.
    columns: { nodeId: string; widthPx: number }[];
    // The columns pinned to the fixed zone, in the tree's order; widthPx is only used beside.
    pins?: { nodeId: string; mode: PinMode; widthPx: number }[];
    // The first column's floor (#731, #733, #848), whatever it holds, 0 without one.
    fixedNeedPx?: number;
};

// The tab's columns in 360 view, or null when there is nothing to lay out (no tree, or a single panel).
export function splitCarpetColumns(root: LayoutNode): CarpetColumns {
    if (root == null || !root.children?.length) {
        return null;
    }
    if (root.flexDirection === FlexDirection.Row && root.children.length > 1) {
        return { fixed: root.children[0], carpet: root.children.slice(1) };
    }
    return { fixed: root, carpet: [] };
}

// Where a split beside a panel lands in 360 view (#677): a new top-level column right before or after the source's
// column, so a left split sits before it on the carpet and a right split after it. Nothing goes before the fixed
// zone's column (it would take its place): a split from there becomes the carpet's first column either way. A source
// outside the tree goes to the end of the carpet; a tree that is not a row yet is wrapped, the new panel after it.
export function carpetSplitPlace(
    root: LayoutNode,
    targetNodeId: string,
    position: "before" | "after"
): { targetNodeId: string; position: "before" | "after" } {
    if (root.flexDirection !== FlexDirection.Row || !root.children?.length) {
        return { targetNodeId: root.id, position: "after" };
    }
    const contains = (node: LayoutNode): boolean =>
        node.id === targetNodeId || (node.children ?? []).some((child) => contains(child));
    const index = root.children.findIndex(contains);
    if (index === -1) {
        return { targetNodeId: root.children[root.children.length - 1].id, position: "after" };
    }
    if (index === 0) {
        return { targetNodeId: root.children[0].id, position: "after" };
    }
    return { targetNodeId: root.children[index].id, position };
}

// The leaf a column's kind is taken from: its top (first) leaf.
export function columnLeadLeaf(column: LayoutNode): LayoutNode {
    let node = column;
    while (node?.children?.length) {
        node = node.children[0];
    }
    return node ?? null;
}

// Every view has a carpet width, terminals and the Project view included: on the carpet they do not fill.
export function carpetColumnKind(view: string): string {
    return view || null;
}

export function defaultCarpetWidthPx(kind: string): number {
    return DefaultCarpetWidths[kind] ?? DefaultCarpetColumnPx;
}

// Why a fixed column's handle cannot move (#829): the first column's floor takes all the room the carpet leaves, the window is
// too narrow, or the other fixed columns take the rest.
export type NoRoomReason = "floor" | "window" | "columns";

export type FixedBounds = { min: number; max: number; noRoom?: NoRoomReason };

function floorPx(needPx: number): number {
    return Number.isFinite(needPx) && needPx > 0 ? Math.ceil(needPx) : 0;
}

// The cap of the fixed zone holding columns side by side (FR-SHELL-067): half of the window, lifted to the first
// column's floor (#733, #848) as long as one carpet column at its readable minimum still fits beside it.
export function fixedCapPx(width: number, needPx = 0): number {
    const half = Math.max(0, Math.floor(width * FixedMaxShare));
    const need = floorPx(needPx);
    return need > half && need + CarpetReservePx <= width ? need : half;
}

// The drag range of the fixed zone alone. It keeps FixedMinPx and the first column's floor (#733) at least, and half of the
// window at most. When that minimum does not fit under half (a floor above half, a window under 2 × FixedMinPx), the
// cap rises to what leaves the carpet one readable column, so the zone can still be widened and narrowed (#829); a
// minimum past even that cap falls back to half of the window. min == max only when the window leaves no room.
export function fixedBoundsPx(width: number, needPx = 0): FixedBounds {
    const half = Math.max(0, Math.floor(width * FixedMaxShare));
    const room = Math.max(0, Math.floor(width) - CarpetReservePx);
    const need = floorPx(needPx);
    const wanted = Math.max(FixedMinPx, need);
    const max = wanted > half ? Math.max(half, room) : half;
    const min = wanted <= max ? wanted : half;
    if (min < max) {
        return { min, max };
    }
    return { min, max, noRoom: need > 0 && need >= max ? "floor" : "window" };
}

// The drag range of the grip of the fixed zone alone. The grip sets the first column's floor (#848), so it can narrow
// the zone below the current floor down to FixedMinPx; the floor still lifts the cap (fixedBoundsPx).
export function fixedDragBoundsPx(width: number, needPx = 0): FixedBounds {
    const max = fixedBoundsPx(width, needPx).max;
    const min = Math.min(fixedBoundsPx(width).min, max);
    return min < max ? { min, max } : { min, max, noRoom: "window" };
}

export function clampFixedDragPx(px: number, width: number, needPx = 0): number {
    const { min, max } = fixedDragBoundsPx(width, needPx);
    const want = Number.isFinite(px) && px > 0 ? px : min;
    return Math.round(Math.min(Math.max(want, min), max));
}

// The drag range of one of the fixed columns side by side: it takes what the others leave of the zone's cap, never
// less than its minimum.
export function sideColumnBoundsPx(width: number, needPx: number, othersPx: number): FixedBounds {
    const min = PinnedColumnMinPx;
    const max = Math.max(min, Math.floor(fixedCapPx(width, needPx) - othersPx));
    return max > min ? { min, max } : { min, max, noRoom: "columns" };
}

export function clampFixedPx(px: number, width: number, needPx = 0): number {
    const { min, max } = fixedBoundsPx(width, needPx);
    const want = Number.isFinite(px) && px > 0 ? px : min;
    return Math.round(Math.min(Math.max(want, min), max));
}

export function clampColumnPx(px: number, viewportWidth: number): number {
    const max = Math.max(MinCarpetColumnPx, viewportWidth);
    const want = Number.isFinite(px) && px > 0 ? px : DefaultCarpetColumnPx;
    return Math.round(Math.min(Math.max(want, MinCarpetColumnPx), max));
}

function sumPx(values: number[]): number {
    return values.reduce((acc, v) => acc + v, 0);
}

// Whether one more column fits beside the first in the fixed zone: every fixed column at its minimum, with the gaps
// between them, within half of the window (FR-SHELL-067-AC3).
export function canPinBeside(width: number, besideCount: number): boolean {
    const columns = besideCount + 2;
    const needed = columns * PinnedColumnMinPx + (columns - 1) * FixedColumnGapPx;
    return needed <= fixedCapPx(width);
}

// The widths of the fixed zone's columns side by side, the first one then those pinned beside it, within half of the
// window. When they do not fit, the pinned columns shrink to their minimum first, then the first column; below every
// minimum (a very narrow window) they share the half in proportion, so the carpet never loses its space.
// needPx: the first column's floor (#733, #848), kept while the pinned columns can still shrink to their minimum.
export function fitFixedWidths(width: number, firstPx: number, pinnedPx: number[], needPx = 0): number[] {
    if (!pinnedPx.length) {
        return [clampFixedPx(firstPx, width, needPx)];
    }
    const avail = Math.max(0, fixedCapPx(width, needPx) - FixedColumnGapPx * pinnedPx.length);
    const want = (px: number, fallback: number) =>
        Math.max(PinnedColumnMinPx, Number.isFinite(px) && px > 0 ? px : fallback);
    const need = Number.isFinite(needPx) && needPx > 0 ? needPx : 0;
    const firstMin = Math.max(PinnedColumnMinPx, Math.min(need, avail - PinnedColumnMinPx * pinnedPx.length));
    let first = Math.max(want(firstPx, FixedMinPx), firstMin);
    let pins = pinnedPx.map((px) => want(px, DefaultCarpetColumnPx));
    let over = first + sumPx(pins) - avail;
    if (over > 0) {
        const room = sumPx(pins.map((px) => px - PinnedColumnMinPx));
        const take = Math.min(over, room);
        if (room > 0) {
            pins = pins.map((px) => px - ((px - PinnedColumnMinPx) * take) / room);
        }
        over -= take;
    }
    if (over > 0) {
        const take = Math.max(0, Math.min(over, first - firstMin));
        first -= take;
        over -= take;
    }
    if (over > 0) {
        const scale = avail / (first + sumPx(pins));
        first *= scale;
        pins = pins.map((px) => px * scale);
    }
    return [first, ...pins].map((px) => Math.floor(px));
}

// The fixed zone's columns: the first one and those pinned beside it side by side, those stacked under the first one
// sharing its width at equal heights.
function layoutFixedColumns(input: CarpetLayoutInput, width: number, height: number): FixedColumn[] {
    const pins = input.pins ?? [];
    const beside = pins.filter((p) => p.mode === "beside");
    const stacked = pins.filter((p) => p.mode === "stacked");
    const widths = fitFixedWidths(
        width,
        input.fixedPx,
        beside.map((p) => p.widthPx),
        input.fixedNeedPx
    );
    const rows = stacked.length + 1;
    const rowHeight = Math.max(0, (height - FixedColumnGapPx * stacked.length) / rows);
    const rtn: FixedColumn[] = [
        { nodeId: input.fixedNodeId, mode: "first", rect: { top: 0, left: 0, width: widths[0], height: rowHeight } },
    ];
    stacked.forEach((pin, i) => {
        const top = (i + 1) * (rowHeight + FixedColumnGapPx);
        rtn.push({ nodeId: pin.nodeId, mode: "stacked", rect: { top, left: 0, width: widths[0], height: rowHeight } });
    });
    let left = widths[0];
    beside.forEach((pin, i) => {
        left += FixedColumnGapPx;
        rtn.push({ nodeId: pin.nodeId, mode: "beside", rect: { top: 0, left, width: widths[i + 1], height } });
        left += widths[i + 1];
    });
    // The tree's order, so the fixed zone reads like the normal layout.
    const order = new Map(pins.map((p, i) => [p.nodeId, i]));
    return [rtn[0], ...rtn.slice(1).sort((a, b) => order.get(a.nodeId) - order.get(b.nodeId))];
}

export function computeCarpetLayout(input: CarpetLayoutInput): CarpetLayout {
    const width = Math.max(0, input.width);
    const height = Math.max(0, input.height);
    const fixedColumns = layoutFixedColumns(input, width, height);
    const fixedPx = Math.max(...fixedColumns.map((c) => c.rect.left + c.rect.width));
    const fixed: Rect = { top: 0, left: 0, width: fixedPx, height };
    const surfaceLeft = fixedPx + CarpetMarginPx;
    const surface: Rect = {
        top: CarpetMarginPx,
        left: surfaceLeft,
        width: Math.max(0, width - surfaceLeft - CarpetMarginPx),
        height: Math.max(0, height - 2 * CarpetMarginPx),
    };
    const viewport: Rect = {
        top: surface.top + CarpetPadTopPx,
        left: surface.left + CarpetPadXPx,
        width: Math.max(0, surface.width - 2 * CarpetPadXPx),
        height: Math.max(0, surface.height - CarpetPadTopPx - CarpetScrubberPx),
    };
    // The invitations are part of the content: scrolling to either end reaches one, and they never cover a panel.
    const invites: CarpetInvite[] = [];
    let x = 0;
    if (input.columns.length) {
        invites.push({ end: "start", x: 0, width: CarpetInvitePx });
        x = CarpetInvitePx + CarpetColumnGapPx;
    }
    const columns: CarpetColumn[] = input.columns.map((col, i) => {
        const colWidth = clampColumnPx(col.widthPx, carpetPanelRoomPx(viewport.width));
        const rtn = { nodeId: col.nodeId, x: x + (i > 0 ? CarpetColumnGapPx : 0), width: colWidth };
        x = rtn.x + colWidth;
        return rtn;
    });
    const endX = columns.length ? x + CarpetColumnGapPx : 0;
    invites.push({ end: "end", x: endX, width: CarpetInvitePx });
    const contentWidth = endX + CarpetInvitePx;
    return {
        fixedNodeId: input.fixedNodeId,
        fixed,
        fixedColumns,
        surface,
        viewport,
        columns,
        invites,
        contentWidth,
        maxScroll: lastScrollStop(columns, contentWidth, viewport.width),
    };
}

// The width panels share on a carpet of this width: what the end invitation and its gap leave (#1131).
export function carpetPanelRoomPx(viewportWidth: number): number {
    return Math.max(0, viewportWidth - CarpetEndReservePx);
}

// The carpet's last position (#1131): the first panel edge from which the end of the carpet is in view, so it shows
// whole panels. When the panels' widths do not add up to the carpet's, the carpet ends with some empty room rather
// than a cut panel. Only when no edge works (the last panel and its invitation wider than the carpet) does it stop
// where the content ends.
function lastScrollStop(columns: CarpetColumn[], contentWidth: number, viewWidth: number): number {
    const contentEnd = Math.max(0, contentWidth - viewWidth);
    if (contentEnd <= EdgeEpsilonPx) {
        return 0;
    }
    const edge = columns.map((c) => c.x).find((x) => x >= contentEnd - EdgeEpsilonPx);
    return edge ?? contentEnd;
}

// The carpet's snap positions, left to right (#1131): its start (with the start invitation), each panel's start
// edge, and its last position. Stepping and revealing a panel stop there.
export function carpetScrollStops(layout: CarpetLayout): number[] {
    if (layout == null) {
        return [0];
    }
    const stops = [0];
    for (const column of layout.columns) {
        if (column.x < layout.maxScroll - EdgeEpsilonPx && column.x > stops[stops.length - 1] + EdgeEpsilonPx) {
            stops.push(column.x);
        }
    }
    if (layout.maxScroll > stops[stops.length - 1] + EdgeEpsilonPx) {
        stops.push(layout.maxScroll);
    }
    return stops;
}

// Where a carpet column (or an invitation) is drawn before scrolling, in the layout's coordinates.
export function carpetColumnRect(layout: CarpetLayout, column: { x: number; width: number }): Rect {
    return {
        top: layout.viewport.top,
        left: layout.viewport.left + column.x,
        width: column.width,
        height: layout.viewport.height,
    };
}

export function clampScroll(layout: CarpetLayout, scrollLeft: number): number {
    if (layout == null || !Number.isFinite(scrollLeft)) {
        return 0;
    }
    return Math.min(Math.max(scrollLeft, 0), layout.maxScroll);
}

// The columns at least partly in view at this scroll position, left to right.
export function visibleCarpetColumnIds(layout: CarpetLayout, scrollLeft: number): string[] {
    if (layout == null) {
        return [];
    }
    const start = clampScroll(layout, scrollLeft);
    const end = start + layout.viewport.width;
    return layout.columns.filter((c) => c.x + c.width > start && c.x < end).map((c) => c.nodeId);
}

// The scroll position that brings a column fully into view: the current one when it already is, otherwise the nearest
// snap position showing it whole (#1131), so the carpet stops on panel edges. A column wider than the carpet shows its
// start; one not on the carpet keeps the current position. The first and last columns bring their end's invitation
// along when both fit (#702): a panel just added at an end leaves the invitation in view, to add another.
export function scrollToRevealColumn(layout: CarpetLayout, nodeId: string, scrollLeft: number): number {
    const current = clampScroll(layout, scrollLeft);
    const index = layout?.columns.findIndex((c) => c.nodeId === nodeId) ?? -1;
    if (index === -1) {
        return current;
    }
    const column = layout.columns[index];
    const viewWidth = layout.viewport.width;
    const start = column.x;
    const end = column.x + column.width;
    const shows = (pos: number) => pos <= start + EdgeEpsilonPx && pos + viewWidth >= end - EdgeEpsilonPx;
    const stops = carpetScrollStops(layout).filter(shows);
    if (!stops.length) {
        return clampScroll(layout, start);
    }
    if (index === 0 && stops[0] === 0) {
        return 0;
    }
    const last = stops[stops.length - 1];
    if (index === layout.columns.length - 1 && Math.abs(last - layout.maxScroll) <= EdgeEpsilonPx) {
        return layout.maxScroll;
    }
    if (shows(current)) {
        return current;
    }
    return stops.reduce((best, pos) => (Math.abs(pos - current) < Math.abs(best - current) ? pos : best));
}

// Where a panel added at an end of the carpet goes in the tree (#702): a new top-level column right before the first
// carpet column, or right after the last one. A carpet with no column (everything fixed or pinned) gets it after the
// root's last column; a tree that is not a row yet is wrapped, the new panel after it.
export function carpetInsertPlace(
    root: LayoutNode,
    layout: CarpetLayout,
    end: CarpetEnd
): { targetNodeId: string; position: "before" | "after" } {
    if (root == null) {
        return null;
    }
    if (root.flexDirection !== FlexDirection.Row || !root.children?.length) {
        return { targetNodeId: root.id, position: "after" };
    }
    const onCarpet = (layout?.columns ?? []).filter((c) => root.children.some((child) => child.id === c.nodeId));
    if (!onCarpet.length) {
        return { targetNodeId: root.children[root.children.length - 1].id, position: "after" };
    }
    if (end === "start") {
        return { targetNodeId: onCarpet[0].nodeId, position: "before" };
    }
    return { targetNodeId: onCarpet[onCarpet.length - 1].nodeId, position: "after" };
}

// The inline CSS for a node drawn on the carpet: its position follows the --mt-carpet-scroll variable, so scrolling
// changes one property on the layout's root and nothing is rendered again; the clip cuts it at the carpet's edges
// while leaving room for its shadow.
export const CarpetScrollVar = "--mt-carpet-scroll";
const ShadowRoomPx = 28;

export function carpetNodeTransform(rect: Rect, layout: CarpetLayout): { transform: string; clipPath: string } {
    const left = Math.floor(rect.left);
    const top = Math.floor(rect.top);
    const width = Math.ceil(rect.width);
    const edgeLeft = layout.surface.left;
    const edgeRight = layout.surface.left + layout.surface.width;
    const scroll = `var(${CarpetScrollVar}, 0px)`;
    // Amount cut on each side: the part of the node past the surface's left or right edge once scrolled.
    const cutLeft = `max(-${ShadowRoomPx}px, calc(${scroll} - ${left - edgeLeft}px))`;
    const cutRight = `max(-${ShadowRoomPx}px, calc(${left + width - edgeRight}px - ${scroll}))`;
    return {
        transform: `translate3d(calc(${left}px - ${scroll}), ${top}px, 0)`,
        clipPath: `inset(-${ShadowRoomPx}px ${cutRight} -${ShadowRoomPx}px ${cutLeft})`,
    };
}
