// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Panel size memory (#606): a side panel reopens at the size the developer last dragged it to, per panel kind, while
// terminals and the Project view always fill what is left. Kept apart from the layout so the rules are tested alone.

// The terminal floor (#731): the width the developer last dragged a terminal to, shared by every terminal. No
// terminal is laid out narrower than it, a terminal still grows above it.

import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { LegacyTimelineView, MoltentermProjectView } from "../project/project-model";

export const PanelSizesMetaKey = "molten:panelsizes";
// Its own key: molten:panelsizes["term"] already holds the width of a terminal column on the 360 carpet (#614).
export const TerminalFloorMetaKey = "molten:terminalfloor";
export const TerminalView = "term";

// The width or height a terminal beside a remembered panel keeps at least, so it stays usable on a small window.
export const MinFillPx = 320;
// Matches the layout's own smallest node (MinNodeSizePx in frontend/layout/lib/layoutModel.ts).
export const MinPanelPx = 40;

// The layout's resize action refuses a size above 100, so the computed sizes share this total.
const SizeTotal = 100;

const FillViews = new Set(["term", MoltentermProjectView, LegacyTimelineView]);

export type PanelAxis = "width" | "height";

export type PanelSize = { width?: number; height?: number };

export type PanelSizes = Record<string, PanelSize>;

export type PanelSibling = {
    size: number;
    // A terminal, the Project view or a group of panels: it takes the room the remembered panel leaves.
    fill: boolean;
    // The width a filling sibling keeps at least when it is above MinFillPx: the terminal floor of the terminals in it.
    minPx?: number;
};

export type IsTerminalLeaf = (leaf: LayoutNode) => boolean;

// The kind a panel's size is remembered under, or null for the views that always fill the remaining space.
export function panelSizeKind(view: string): string {
    if (!view || FillViews.has(view)) {
        return null;
    }
    return view;
}

function validPx(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// The stored sizes, keeping only the well-formed entries: the meta is written by older and newer versions alike.
export function readPanelSizes(raw: unknown): PanelSizes {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        return {};
    }
    const rtn: PanelSizes = {};
    for (const [kind, value] of Object.entries(raw as Record<string, unknown>)) {
        if (value == null || typeof value !== "object") {
            continue;
        }
        const width = validPx((value as PanelSize).width);
        const height = validPx((value as PanelSize).height);
        if (width == null && height == null) {
            continue;
        }
        rtn[kind] = {};
        if (width != null) {
            rtn[kind].width = width;
        }
        if (height != null) {
            rtn[kind].height = height;
        }
    }
    return rtn;
}

export function rememberPanelSize(sizes: PanelSizes, kind: string, axis: PanelAxis, px: number): PanelSizes {
    if (!kind || validPx(px) == null) {
        return sizes;
    }
    return { ...sizes, [kind]: { ...sizes[kind], [axis]: Math.round(px) } };
}

export function rememberedPanelPx(sizes: PanelSizes, kind: string, axis: PanelAxis): number {
    if (!kind) {
        return null;
    }
    return validPx(sizes?.[kind]?.[axis]) ?? null;
}

// The stored terminal floor, or null when the developer has not set one (or "Readjust every size" cleared it).
export function readTerminalFloor(raw: unknown): number {
    const px = validPx(raw);
    return px == null ? null : Math.round(px);
}

// The floor a splitter drag sets from the widths it gave the terminals it moved: the smallest, so that right after the
// drag no terminal is under the floor. Null when the drag moved no terminal's width.
export function floorFromDraggedTerminals(widthsPx: number[]): number {
    const valid = (widthsPx ?? []).map(validPx).filter((px) => px != null);
    if (!valid.length) {
        return null;
    }
    return Math.round(Math.min(...valid));
}

// The width `node` needs so that each terminal in it keeps the floor: the floor for a terminal, the largest need of
// the children of a column split (they share its width) and the sum for a row split (side by side). Gaps are left to
// the callers' margins.
export function terminalNeedPx(node: LayoutNode, floorPx: number, isTerminal: IsTerminalLeaf): number {
    if (node == null || !(floorPx > 0)) {
        return 0;
    }
    if (!node.children?.length) {
        return isTerminal(node) ? floorPx : 0;
    }
    const needs = node.children.map((c) => terminalNeedPx(c, floorPx, isTerminal));
    if (node.flexDirection === FlexDirection.Row) {
        return needs.reduce((acc, n) => acc + n, 0);
    }
    return Math.max(0, ...needs);
}

// The terminals whose width is the node's own: the node itself, or terminals stacked in it through column splits only
// (a terminal in a nested row split has a share of the width, not all of it).
export function fullWidthTerminals(node: LayoutNode, isTerminal: IsTerminalLeaf): LayoutNode[] {
    if (node == null) {
        return [];
    }
    if (!node.children?.length) {
        return isTerminal(node) ? [node] : [];
    }
    if (node.flexDirection === FlexDirection.Row && node.children.length > 1) {
        return [];
    }
    return node.children.flatMap((c) => fullWidthTerminals(c, isTerminal));
}

function fillMinPx(s: PanelSibling): number {
    return Math.max(MinFillPx, validPx(s.minPx) ?? 0);
}

// The largest size the panel at `index` can take among its siblings: the other remembered panels keep theirs and every
// filling sibling keeps MinFillPx (or its terminal floor when larger); with no filling sibling, every other panel
// keeps MinFillPx.
export function maxPanelPx(siblings: PanelSibling[], index: number, ratio: number): number {
    const availPx = siblings.reduce((acc, s) => acc + s.size, 0) / ratio;
    const others = siblings.filter((_, i) => i !== index);
    const fills = others.filter((s) => s.fill);
    if (fills.length === 0) {
        return availPx - others.length * MinFillPx;
    }
    const fixedPx = others.filter((s) => !s.fill).reduce((acc, s) => acc + s.size / ratio, 0);
    return availPx - fixedPx - fills.reduce((acc, s) => acc + fillMinPx(s), 0);
}

// The sizes of the siblings once the panel at `index` takes `targetPx` (clamped so the others stay usable), or null
// when even the smallest panel does not fit. `ratio` is the parent's size units per pixel. The clamp only shapes the
// layout: the remembered value is left as it is, so a bigger window gets the full size back on the next open.
// A terminal floor that leaves no room for the smallest panel is dropped for this layout (the 360 view's automatic
// decision takes over when it is on): the panel still opens, the terminals keep MinFillPx.
export function sizesForRememberedPanel(
    siblings: PanelSibling[],
    index: number,
    targetPx: number,
    ratio: number
): number[] {
    if (siblings.length < 2 || index < 0 || index >= siblings.length || !(ratio > 0) || validPx(targetPx) == null) {
        return null;
    }
    const total = siblings.reduce((acc, s) => acc + s.size, 0);
    const availPx = total / ratio;
    const maxPx = maxPanelPx(siblings, index, ratio);
    if (!(availPx > 0)) {
        return null;
    }
    if (maxPx < MinPanelPx) {
        if (!siblings.some((s) => s.minPx != null)) {
            return null;
        }
        return sizesForRememberedPanel(
            siblings.map((s) => ({ size: s.size, fill: s.fill })),
            index,
            targetPx,
            ratio
        );
    }
    const panelPx = Math.min(Math.max(targetPx, MinPanelPx), maxPx);
    const px = siblings.map((s) => s.size / ratio);
    const others = siblings.map((s, i) => i).filter((i) => i !== index);
    const fills = others.filter((i) => siblings[i].fill);
    // Without a filling sibling every other panel gives way in proportion; with one, only the filling ones do.
    const yielding = fills.length > 0 ? fills : others;
    const keptPx = others.filter((i) => !yielding.includes(i)).reduce((acc, i) => acc + px[i], 0);
    const yieldingPx = yielding.reduce((acc, i) => acc + px[i], 0);
    const leftPx = availPx - keptPx - panelPx;
    const shared = shareRoom(
        yielding.map((i) => (yieldingPx > 0 ? px[i] : 1)),
        leftPx,
        yielding.map((i) => (siblings[i].fill ? fillMinPx(siblings[i]) : MinFillPx))
    );
    const rtnPx = [...px];
    rtnPx[index] = panelPx;
    yielding.forEach((i, k) => {
        rtnPx[i] = shared[k];
    });
    return rtnPx.map((p) => (p / availPx) * SizeTotal);
}

// Shares `room` pixels in proportion to `weights`, each share at least `min` when the room allows it: a narrow
// terminal next to a wide group keeps a usable width instead of its proportional sliver. `min` is one minimum for all
// or one per share; minimums above the room are scaled down together.
export function shareRoom(weights: number[], room: number, min: number | number[]): number[] {
    const rtn = weights.map(() => 0);
    const mins = weights.map((_, i) => (Array.isArray(min) ? (min[i] ?? 0) : min));
    const minTotal = mins.reduce((acc, m) => acc + m, 0);
    const scale = minTotal > room && minTotal > 0 ? Math.max(0, room) / minTotal : 1;
    const floors = mins.map((m) => m * scale);
    let open = weights.map((_, i) => i);
    let left = room;
    while (open.length) {
        const total = open.reduce((acc, i) => acc + weights[i], 0);
        const short = open.filter((i) => (left * weights[i]) / total < floors[i]);
        if (!short.length) {
            for (const i of open) {
                rtn[i] = (left * weights[i]) / total;
            }
            break;
        }
        for (const i of short) {
            rtn[i] = floors[i];
            left -= floors[i];
        }
        open = open.filter((i) => !short.includes(i));
    }
    return rtn;
}
