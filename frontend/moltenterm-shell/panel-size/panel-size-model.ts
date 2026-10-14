// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Panel size memory (#606): a side panel reopens at the size the developer last dragged it to, per panel kind, while
// terminals and the Project view always fill what is left. Kept apart from the layout so the rules are tested alone.

import { LegacyTimelineView, MoltentermProjectView } from "../project/project-model";

export const PanelSizesMetaKey = "molten:panelsizes";

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
};

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

// The largest size the panel at `index` can take among its siblings: the other remembered panels keep theirs and every
// filling sibling keeps MinFillPx; with no filling sibling, every other panel keeps MinFillPx.
export function maxPanelPx(siblings: PanelSibling[], index: number, ratio: number): number {
    const availPx = siblings.reduce((acc, s) => acc + s.size, 0) / ratio;
    const others = siblings.filter((_, i) => i !== index);
    const fillCount = others.filter((s) => s.fill).length;
    if (fillCount === 0) {
        return availPx - others.length * MinFillPx;
    }
    const fixedPx = others.filter((s) => !s.fill).reduce((acc, s) => acc + s.size / ratio, 0);
    return availPx - fixedPx - fillCount * MinFillPx;
}

// The sizes of the siblings once the panel at `index` takes `targetPx` (clamped so the others stay usable), or null
// when even the smallest panel does not fit. `ratio` is the parent's size units per pixel. The clamp only shapes the
// layout: the remembered value is left as it is, so a bigger window gets the full size back on the next open.
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
    if (!(availPx > 0) || maxPx < MinPanelPx) {
        return null;
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
        MinFillPx
    );
    const rtnPx = [...px];
    rtnPx[index] = panelPx;
    yielding.forEach((i, k) => {
        rtnPx[i] = shared[k];
    });
    return rtnPx.map((p) => (p / availPx) * SizeTotal);
}

// Shares `room` pixels in proportion to `weights`, each share at least `min` when the room allows it: a narrow
// terminal next to a wide group keeps a usable width instead of its proportional sliver.
export function shareRoom(weights: number[], room: number, min: number): number[] {
    const rtn = weights.map(() => 0);
    const floor = Math.min(min, room / Math.max(weights.length, 1));
    let open = weights.map((_, i) => i);
    let left = room;
    while (open.length) {
        const total = open.reduce((acc, i) => acc + weights[i], 0);
        const short = open.filter((i) => (left * weights[i]) / total < floor);
        if (!short.length) {
            for (const i of open) {
                rtn[i] = (left * weights[i]) / total;
            }
            break;
        }
        for (const i of short) {
            rtn[i] = floor;
            left -= floor;
        }
        open = open.filter((i) => !short.includes(i));
    }
    return rtn;
}
