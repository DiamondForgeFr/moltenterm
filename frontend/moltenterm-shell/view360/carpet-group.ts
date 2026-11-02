// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "360 on the pages" (FR-SHELL-124, DS-SHELL-136): the chooser's "On the carpet: All panels · The pages". With the
// pages, only the browser panels stay on the carpet; every other column right of the agent is pinned in the fixed
// zone, beside the agent while the half-window rule of FR-SHELL-067 allows it, under it otherwise, never refused. Those
// pins carry the grouping's mark and leave with it; the developer's own pins are never touched. Pages are the only
// panels that come in numbers; terminals stay where they are, the agent alone on the left.

import type { LayoutNode } from "@/layout/lib/types";
import { MoltentermBrowserView } from "../browser/browser-model";
import { canPinBeside, type PinMode } from "./carpet-model";
import { columnBlockIds, columnPin, GroupPinOrigin, handPins, type TabPins } from "./pin-model";

export const GroupAll = "all";
export const GroupPages = "pages";
export type CarpetGroup = typeof GroupAll | typeof GroupPages;

// A page is a browser panel (FR-SHELL-083), Moltenterm's or Wave's own.
export const PageViews: ReadonlySet<string> = new Set([MoltentermBrowserView, "web"]);

export function readGroup(raw: unknown): CarpetGroup {
    return raw === GroupPages ? GroupPages : GroupAll;
}

// A column is a page when every panel in it is one: a column holding anything else is not flipped through as a tab.
export function isPageColumn(column: LayoutNode, viewOf: (blockId: string) => string): boolean {
    const ids = columnBlockIds(column);
    return ids.length > 0 && ids.every((id) => PageViews.has(viewOf(id)));
}

export type GroupColumns = { pages: LayoutNode[]; others: LayoutNode[] };

// The columns right of the agent the developer did not pin, parted into pages and the others, in the tree's order.
export function groupColumns(
    columns: LayoutNode[],
    pins: TabPins,
    viewOf: (blockId: string) => string
): GroupColumns {
    const hand = handPins(pins);
    const pages: LayoutNode[] = [];
    const others: LayoutNode[] = [];
    for (const column of columns ?? []) {
        if (columnPin(column, hand) != null) {
            continue;
        }
        (isPageColumn(column, viewOf) ? pages : others).push(column);
    }
    return { pages, others };
}

// The choice is shown only when it changes something (AC1): at least two pages and at least one other panel.
export function groupOffered(columns: LayoutNode[], pins: TabPins, viewOf: (blockId: string) => string): boolean {
    const { pages, others } = groupColumns(columns, pins, viewOf);
    return pages.length >= 2 && others.length >= 1;
}

export type GroupPin = { blockId: string; mode: PinMode };

// Whether the pages keep one readable place once the fixed zone holds these beside columns (their widths, the
// developer's first). Without it, only the half-window rule decides.
export type BesideRoom = (besideWidthsPx: number[]) => boolean;

// Where the grouping pins each other column (AC2), in the tree's order: beside the agent while one more beside column
// fits within half of the window (the developer's beside pins counted first) and the pages keep a readable place,
// under the agent once it does not.
export function groupPinPlan(
    columns: LayoutNode[],
    pins: TabPins,
    viewOf: (blockId: string) => string,
    widthPx: number,
    room?: { handBesidePx: number[]; widthOf: (column: LayoutNode) => number; fits: BesideRoom }
): GroupPin[] {
    const hand = handPins(pins);
    let beside = Object.values(hand).filter((p) => p.mode === "beside").length;
    const besidePx = [...(room?.handBesidePx ?? [])];
    const plan: GroupPin[] = [];
    for (const column of groupColumns(columns, pins, viewOf).others) {
        const blockId = columnBlockIds(column)[0];
        if (blockId == null) {
            continue;
        }
        const px = room?.widthOf(column);
        const fits = canPinBeside(widthPx, beside) && (room == null || room.fits([...besidePx, px]));
        const mode: PinMode = fits ? "beside" : "stacked";
        if (fits) {
            beside++;
            besidePx.push(px);
        }
        plan.push({ blockId, mode });
    }
    return plan;
}

// The view's pins under a grouping: "all" keeps the developer's pins only (the marked ones leave, AC4), "pages" adds
// the grouping's, marked.
export function groupedPins(
    group: CarpetGroup,
    columns: LayoutNode[],
    pins: TabPins,
    viewOf: (blockId: string) => string,
    widthPx: number,
    room?: Parameters<typeof groupPinPlan>[4]
): TabPins {
    const rtn = handPins(pins);
    if (group !== GroupPages) {
        return rtn;
    }
    for (const { blockId, mode } of groupPinPlan(columns, pins, viewOf, widthPx, room)) {
        rtn[blockId] = { mode, by: GroupPinOrigin };
    }
    return rtn;
}
