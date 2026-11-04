// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The carpet's edge peeks (FR-SHELL-065 AC11, DS-SHELL-152), kept apart from React so they are tested alone: which
// panel each edge shows, where its sliver is drawn, and which columns in view may be captured.

import type { CaptureRect, CaptureTarget } from "./carpet-captures";
import { carpetColumnRect, CarpetEdgePx, CarpetEnd, CarpetLayout, Rect } from "./carpet-model";

// The sliver: narrower than its gutter, the rest of which keeps the normal gap to the panels beside it.
export const PeekWidthPx = 12;
// The sliver is shorter than the panels, like a card set back.
export const PeekInsetYPx = 16;
const EdgeEpsilonPx = 0.5;

export type PeekSide = "left" | "right";

// The panels each edge shows: the column just before the first one in view, and the one just after the last one.
// Partly visible columns count as in view, so a peek never doubles a panel cut at the edge. None where no such
// column exists (an end of the carpet), and none when nothing is in view.
export function peekNeighbours<T extends { columnId: string; visible: boolean }>(ticks: T[]): { left: T; right: T } {
    const first = (ticks ?? []).findIndex((t) => t.visible);
    if (first === -1) {
        return { left: null, right: null };
    }
    let last = first;
    for (let i = first; i < ticks.length; i++) {
        if (ticks[i].visible) {
            last = i;
        }
    }
    return { left: first > 0 ? ticks[first - 1] : null, right: last < ticks.length - 1 ? ticks[last + 1] : null };
}

// Where a peek is drawn, in the layout's coordinates: inside its gutter, on the band of places' side, so the panels'
// own half gap separates it from the place beside it; its height is inset from the panels'.
export function peekRect(layout: CarpetLayout, side: PeekSide, halfGapPx: number): Rect {
    const v = layout.viewport;
    const gap = Math.max(0, halfGapPx);
    const top = v.top + gap + PeekInsetYPx;
    const height = Math.max(0, v.height - 2 * gap - 2 * PeekInsetYPx);
    const inner = Math.max(0, CarpetEdgePx - PeekWidthPx - gap);
    const left = side === "left" ? v.left - inner - PeekWidthPx : v.left + v.width + inner;
    return { top, left, width: PeekWidthPx, height };
}

// The ends of the carpet whose gutter holds an add-panel slot (#1836, FR-SHELL-065 AC15): the side where a panel is in
// view and none lies beyond it, which is where no peek is drawn, so the room the tilt needs never reads as a hole.
// "left" is the start of the carpet, "right" its end.
export function endSlotSides<T extends { columnId: string; visible: boolean }>(ticks: T[]): PeekSide[] {
    if (!(ticks ?? []).some((t) => t.visible)) {
        return [];
    }
    const { left, right } = peekNeighbours(ticks);
    const sides: PeekSide[] = [];
    if (left == null) {
        sides.push("left");
    }
    if (right == null) {
        sides.push("right");
    }
    return sides;
}

// The slots step aside, like the panels' own chrome, while a panel is magnified or being dragged.
export function endSlotsShown(magnifiedNodeId: string, dragging: boolean): boolean {
    return magnifiedNodeId == null && !dragging;
}

// The end of the carpet an add-panel slot on this side adds its panel at.
export function carpetEndOfSide(side: PeekSide): CarpetEnd {
    return side === "left" ? "start" : "end";
}

// Where an add-panel slot is drawn, in the layout's coordinates: the peek's column of the gutter, the height of the
// panels it sits beside, so it reads as the edge of a place waiting to be filled.
export function endSlotRect(layout: CarpetLayout, side: PeekSide, halfGapPx: number): Rect {
    const gap = Math.max(0, halfGapPx);
    const peek = peekRect(layout, side, gap);
    return {
        top: layout.viewport.top + gap,
        left: peek.left,
        width: peek.width,
        height: Math.max(0, layout.viewport.height - 2 * gap),
    };
}

// blockIds: the column's panels' blocks, parallel to leafNodeIds; the first one keys the column's stored thumbnail.
export type CaptureColumn = { columnId: string; leafNodeIds: string[]; blockIds: string[] };

// The columns that may be captured at this scroll position: whole in the band of places (a panel cut at the edge
// would be kept cut), the rect inset by the panels' half gap so only the panel shows, in the window's coordinates.
export function captureTargets(
    layout: CarpetLayout,
    scrollLeft: number,
    origin: { x: number; y: number },
    halfGapPx: number
): CaptureTarget[] {
    if (layout == null) {
        return [];
    }
    const start = layout.viewport.left - EdgeEpsilonPx;
    const end = layout.viewport.left + layout.viewport.width + EdgeEpsilonPx;
    const gap = Math.max(0, halfGapPx);
    const rtn: CaptureTarget[] = [];
    for (const column of layout.columns) {
        const r = carpetColumnRect(layout, column);
        const left = r.left - scrollLeft;
        if (left < start || left + r.width > end) {
            continue;
        }
        const rect: CaptureRect = {
            x: Math.round(origin.x + left + gap),
            y: Math.round(origin.y + r.top + gap),
            width: Math.round(r.width - 2 * gap),
            height: Math.round(r.height - 2 * gap),
        };
        if (rect.width < 1 || rect.height < 1) {
            continue;
        }
        rtn.push({ columnId: column.nodeId, rect });
    }
    return rtn;
}

// Whether a floating element's box (a DOMRect's edges) overlaps a column's capture rect, edges touching not counting.
export function overlapsCapture(
    box: { left: number; right: number; top: number; bottom: number },
    rect: CaptureRect
): boolean {
    return (
        box.right > box.left &&
        box.bottom > box.top &&
        box.left < rect.x + rect.width &&
        box.right > rect.x &&
        box.top < rect.y + rect.height &&
        box.bottom > rect.y
    );
}

// The points a column is hit-tested at before its capture: its centre and four points near its corners. Whatever
// covers one of them (a menu, a popover, a dragged panel) would be captured as the panel.
export function captureProbePoints(rect: CaptureRect): { x: number; y: number }[] {
    const pad = Math.min(16, rect.width / 4, rect.height / 4);
    const right = rect.x + rect.width - pad;
    const bottom = rect.y + rect.height - pad;
    return [
        { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
        { x: rect.x + pad, y: rect.y + pad },
        { x: right, y: rect.y + pad },
        { x: rect.x + pad, y: bottom },
        { x: right, y: bottom },
    ];
}
