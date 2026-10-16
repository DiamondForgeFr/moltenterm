// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// When a tab shows in 360 view (FR-SHELL-066, DS-SHELL-116): the setting moltenterm:view360, the tab's manual choice,
// and in automatic the readable minimum of every column against the tab's width, with a margin before leaving so a
// window dragged around the threshold does not flap. Pure rules, kept apart from the layout so they are tested alone.
// A terminal column counts the terminal floor (#731) on top of its readable minimum. The automatic decision cannot be
// turned off (#733): the tab's button only adds an on-demand 360 view, and leaving is guarded (exitView360).

import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { type IsTerminalLeaf, terminalNeedPx } from "../panel-size/panel-size-model";
import { FixedMinPx, ReadableCarpetColumnPx } from "./carpet-model";

export const View360SettingKey = "moltenterm:view360";

// The readable minimums (tunable): the first column, the same as the fixed zone's minimum, and any other column.
export const FirstColumnMinPx = FixedMinPx;
export const SideColumnMinPx = ReadableCarpetColumnPx;
// Automatic leaves 360 view only once every column fits at its minimum with this much to spare.
export const LeaveMarginPx = 64;
// A width change alone (the window being resized) switches only once the width has held this long.
export const ResizeSettleMs = 250;

export type View360Setting = "auto" | "always";
// Where the tab's state comes from: its own button (on demand, or turned off under the always setting), the always
// setting, or the automatic decision.
export type View360Source = "manual" | "setting" | "auto";

// "never" was removed (#733): a stored one reads as automatic, like anything unknown.
export function normalizeView360Setting(raw: unknown): View360Setting {
    return raw === "always" ? "always" : "auto";
}

// The tab's manual choice, from its meta: true on demand, false turned off (only the always setting yields to it),
// null when it follows the setting.
export function manualChoice(raw: unknown): boolean {
    return raw === true ? true : raw === false ? false : null;
}

// The root's top-level columns; wrappers holding a single child are looked through.
export function topColumns(root: LayoutNode): LayoutNode[] {
    let node = root;
    while (node?.children?.length === 1) {
        node = node.children[0];
    }
    if (node == null) {
        return [];
    }
    if (node.flexDirection === FlexDirection.Row && node.children?.length > 1) {
        return node.children;
    }
    return [node];
}

export function countLeaves(root: LayoutNode): number {
    if (root == null) {
        return 0;
    }
    if (!root.children?.length) {
        return 1;
    }
    return root.children.reduce((acc, c) => acc + countLeaves(c), 0);
}

export function columnMinPx(index: number): number {
    return index === 0 ? FirstColumnMinPx : SideColumnMinPx;
}

// The readable minimum of each of `columnCount` columns.
export function readableMinimumsPx(columnCount: number): number[] {
    return Array.from({ length: Math.max(0, columnCount) }, (_, i) => columnMinPx(i));
}

// The minimum of each top-level column once the terminal floor (#731) counts: max(readable minimum, the width its
// terminals need to keep the floor). Without a floor, the readable minimums.
export function columnMinimumsPx(columns: LayoutNode[], floorPx: number, isTerminal: IsTerminalLeaf): number[] {
    return columns.map((column, i) => Math.max(columnMinPx(i), terminalNeedPx(column, floorPx, isTerminal)));
}

// The width every column needs at its minimum, gaps included: the readable minimums of `columnCount` columns, or the
// given per-column minimums (columnMinimumsPx).
export function minimumsPx(columnCount: number, gapPx = 0, columnMins?: number[]): number {
    if (columnCount <= 0) {
        return 0;
    }
    const mins = columnMins?.length === columnCount ? columnMins : readableMinimumsPx(columnCount);
    return mins.reduce((acc, m) => acc + m, 0) + (columnCount - 1) * Math.max(0, gapPx || 0);
}

// The automatic decision: enter when the minimums no longer fit, leave only when they fit with the margin.
// `columnMins` (columnMinimumsPx) makes a terminal column count its floor.
export function autoWants(
    prevOn: boolean,
    columnCount: number,
    widthPx: number,
    gapPx = 0,
    columnMins?: number[]
): boolean {
    if (columnCount < 2 || !(widthPx > 0)) {
        return false;
    }
    const need = minimumsPx(columnCount, gapPx, columnMins);
    if (prevOn) {
        return need + LeaveMarginPx > widthPx;
    }
    return need > widthPx;
}

// Whether the columns fit side by side at their current minimums, terminal floor included (#733: leave 360 view as is).
export function fitsAtCurrentFloors(columnMins: number[], widthPx: number, gapPx = 0, marginPx = 0): boolean {
    const count = columnMins?.length ?? 0;
    if (count < 2) {
        return true;
    }
    return widthPx > 0 && minimumsPx(count, gapPx, columnMins) + Math.max(0, marginPx) <= widthPx;
}

// Whether the columns fit at their readable minimums alone, the floor ignored (#733: fits only once the floor is
// cleared, "Readjust every size").
export function fitsAtReadableMinimums(columnCount: number, widthPx: number, gapPx = 0, marginPx = 0): boolean {
    if (columnCount < 2) {
        return true;
    }
    return widthPx > 0 && minimumsPx(columnCount, gapPx) + Math.max(0, marginPx) <= widthPx;
}

export type View360Inputs = {
    setting: View360Setting;
    manual: boolean;
    autoOn: boolean;
    columnCount: number;
};

export type View360Decision = { active: boolean; wanted: boolean; source: View360Source };

// wanted: what the tab asks for whatever its columns (a panel opened then goes to the carpet); active: what is drawn,
// never 360 view for a single column (nothing to lay on the carpet). source: what holds the view on (on demand first,
// then the automatic decision, then the always setting), or while off what keeps it off (the tab's own choice under
// the always setting, the automatic decision otherwise).
export function decideView360(inputs: View360Inputs): View360Decision {
    let wanted = false;
    let source: View360Source = "auto";
    if (inputs.manual === true) {
        wanted = true;
        source = "manual";
    } else if (inputs.autoOn) {
        wanted = true;
    } else if (inputs.setting === "always") {
        wanted = inputs.manual !== false;
        source = wanted ? "setting" : "manual";
    }
    return { active: wanted && inputs.columnCount >= 2, wanted, source };
}

// Turning the 360 view off (#733): "leave" when every column fits at the current floors; "readjust" when they fit only
// once the terminal floor is cleared (the developer confirms first); "blocked" when they do not fit even at the
// readable minimums, with how many columns are too many.
export type View360Exit = { kind: "leave" } | { kind: "readjust" } | { kind: "blocked"; extraColumns: number };

// How many columns fit side by side at their readable minimums, at least the first one.
export function maxReadableColumns(widthPx: number, gapPx = 0): number {
    let count = 1;
    while (Number.isFinite(widthPx) && minimumsPx(count + 1, gapPx) <= widthPx) {
        count++;
    }
    return count;
}

export function exitView360(columnMins: number[], widthPx: number, gapPx = 0): View360Exit {
    const count = columnMins?.length ?? 0;
    if (count < 2 || !(widthPx > 0) || fitsAtCurrentFloors(columnMins, widthPx, gapPx)) {
        return { kind: "leave" };
    }
    if (fitsAtReadableMinimums(count, widthPx, gapPx)) {
        return { kind: "readjust" };
    }
    return { kind: "blocked", extraColumns: Math.max(1, count - maxReadableColumns(widthPx, gapPx)) };
}

// The node whose children are the top-level columns (topColumns), or null for a single column.
export function columnsParent(root: LayoutNode): LayoutNode {
    let node = root;
    while (node?.children?.length === 1) {
        node = node.children[0];
    }
    if (node?.flexDirection === FlexDirection.Row && node.children?.length > 1) {
        return node;
    }
    return null;
}

// The columns' sizes (summing to 100) once the width is shared again ("Readjust every size", #733): equal shares, a
// column whose minimum is above its share gets its minimum and the others share the rest. When even the minimums do
// not fit, sizes follow the minimums.
export function sharedColumnSizes(columnMins: number[], widthPx: number, gapPx = 0): number[] {
    const count = columnMins?.length ?? 0;
    if (count === 0) {
        return [];
    }
    const room = widthPx - Math.max(0, gapPx || 0) * (count - 1);
    const mins = columnMins.map((m) => (m > 0 ? m : 0));
    const minTotal = mins.reduce((acc, m) => acc + m, 0);
    if (!(room > 0) || minTotal >= room) {
        const total = minTotal > 0 ? minTotal : count;
        return mins.map((m) => ((minTotal > 0 ? m : 1) / total) * 100);
    }
    const held = new Set<number>();
    let share = room / count;
    for (;;) {
        const heldPx = [...held].reduce((acc, i) => acc + mins[i], 0);
        share = (room - heldPx) / (count - held.size);
        const raise = mins.findIndex((m, i) => !held.has(i) && m > share);
        if (raise < 0) {
            break;
        }
        held.add(raise);
    }
    return mins.map((m, i) => ((held.has(i) ? m : share) / room) * 100);
}

// The width each top-level column takes in the normal layout, from the tree's sizes.
export function normalColumnPxs(sizes: number[], widthPx: number, gapPx = 0): number[] {
    const total = sizes.reduce((acc, s) => acc + (s > 0 ? s : 0), 0);
    if (!(total > 0) || !(widthPx > 0)) {
        return sizes.map(() => 0);
    }
    const room = Math.max(0, widthPx - Math.max(0, gapPx || 0) * (sizes.length - 1));
    return sizes.map((s) => ((s > 0 ? s : 0) / total) * room);
}

export function anyColumnTooTight(columnPxs: number[], columnMins?: number[]): boolean {
    if (columnPxs.length < 2) {
        return false;
    }
    // Half a pixel of rounding is not "too tight".
    return columnPxs.some((px, i) => px + 0.5 < (columnMins?.[i] ?? columnMinPx(i)));
}
