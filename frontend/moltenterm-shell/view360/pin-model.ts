// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Pinning a carpet panel to the fixed zone (FR-SHELL-067, DS-SHELL-118). A pin is kept in the tab's meta under the
// panel's block id, never in the layout tree: the tree keeps its order, so the normal layout is untouched and an
// unpinned panel goes back to the carpet where it was. A carpet column is pinned when one of its panels is, so a
// column split vertically moves as one.

import type { LayoutNode } from "@/layout/lib/types";
import type { PinMode } from "./carpet-model";

export type PinEntry = {
    mode: PinMode;
    // A column pinned beside the first keeps the width it was given there.
    px?: number;
};

// Block id -> pin.
export type TabPins = Record<string, PinEntry>;

export type PinnedColumn = { node: LayoutNode; blockId: string; pin: PinEntry };

function isPinMode(v: unknown): v is PinMode {
    return v === "beside" || v === "stacked";
}

export function parsePins(raw: unknown): TabPins {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        return {};
    }
    const rtn: TabPins = {};
    for (const [blockId, value] of Object.entries(raw as Record<string, unknown>)) {
        const entry = value as Record<string, unknown>;
        if (!blockId || entry == null || typeof entry !== "object" || !isPinMode(entry.mode)) {
            continue;
        }
        const px = entry.px;
        rtn[blockId] =
            typeof px === "number" && Number.isFinite(px) && px > 0 ? { mode: entry.mode, px } : { mode: entry.mode };
    }
    return rtn;
}

function columnBlockIds(column: LayoutNode): string[] {
    if (column == null) {
        return [];
    }
    if (!column.children?.length) {
        return column.data?.blockId ? [column.data.blockId] : [];
    }
    return column.children.flatMap(columnBlockIds);
}

// The pin holding a column in the fixed zone: the first of its panels (top to bottom) that is pinned.
export function columnPin(column: LayoutNode, pins: TabPins): { blockId: string; pin: PinEntry } {
    for (const blockId of columnBlockIds(column)) {
        const pin = pins?.[blockId];
        if (pin != null) {
            return { blockId, pin };
        }
    }
    return null;
}

// The columns other than the first, parted into those left on the carpet and those pinned to the fixed zone, each
// in the tree's order.
export function partPinnedColumns(
    columns: LayoutNode[],
    pins: TabPins
): { carpet: LayoutNode[]; pinned: PinnedColumn[] } {
    const carpet: LayoutNode[] = [];
    const pinned: PinnedColumn[] = [];
    for (const node of columns ?? []) {
        const found = columnPin(node, pins);
        if (found == null) {
            carpet.push(node);
        } else {
            pinned.push({ node, blockId: found.blockId, pin: found.pin });
        }
    }
    return { carpet, pinned };
}

// Pins of panels no longer in the tab are dropped whenever the pins are written.
function pruned(pins: TabPins, liveBlockIds: string[]): TabPins {
    if (liveBlockIds == null) {
        return { ...pins };
    }
    const live = new Set(liveBlockIds);
    return Object.fromEntries(Object.entries(pins ?? {}).filter(([blockId]) => live.has(blockId)));
}

// Pins one panel's column: the other panels of the same column lose their own pin, so a column has one pin.
export function withPin(
    pins: TabPins,
    column: LayoutNode,
    blockId: string,
    mode: PinMode,
    liveBlockIds?: string[]
): TabPins {
    const rtn = withoutPin(pins, column, liveBlockIds);
    rtn[blockId] = { mode };
    return rtn;
}

export function withoutPin(pins: TabPins, column: LayoutNode, liveBlockIds?: string[]): TabPins {
    const rtn = pruned(pins, liveBlockIds);
    for (const id of columnBlockIds(column)) {
        delete rtn[id];
    }
    return rtn;
}

export function withPinWidth(pins: TabPins, blockId: string, px: number): TabPins {
    const pin = pins?.[blockId];
    if (pin == null) {
        return pins;
    }
    return { ...pins, [blockId]: { ...pin, px: Math.round(px) } };
}

export function countBeside(pinned: PinnedColumn[]): number {
    return pinned.filter((p) => p.pin.mode === "beside").length;
}
