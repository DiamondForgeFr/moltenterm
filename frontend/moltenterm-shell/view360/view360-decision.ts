// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// When a tab shows in 360 view (FR-SHELL-066, DS-SHELL-116): the setting moltenterm:view360, the tab's manual choice,
// and in automatic the readable minimum of every column against the tab's width, with a margin before leaving so a
// window dragged around the threshold does not flap. Pure rules, kept apart from the layout so they are tested alone.
// The first column counts its floor (#731, #848) on top of its readable minimum, whatever it holds. The automatic
// decision cannot be turned off (#733): the tab's button only adds an on-demand 360 view, and leaving is guarded
// (exitView360). The developer thinks in space (#1083): beyond the screen's column threshold the tab goes to 360 view,
// the readable minimums staying a safety net, and the proportions the developer set are never readjusted, only kept
// (rememberedFractions) and given back.

import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { FixedMinPx, ReadableCarpetColumnPx } from "./carpet-model";

export const View360SettingKey = "moltenterm:view360";

// The readable minimums (tunable): the first column, the same as the fixed zone's minimum, and any other column.
export const FirstColumnMinPx = FixedMinPx;
export const SideColumnMinPx = ReadableCarpetColumnPx;
// Automatic leaves 360 view only once every column fits at its minimum with this much to spare.
export const LeaveMarginPx = 64;
// The automatic view needs at least two panels on the carpet (#1225): the first column plus two. A carpet holding one
// panel brings nothing, two columns share the width instead. On demand and the always setting keep two columns.
export const AutoMinColumns = 3;
// In a narrow window (FR-SHELL-109) the sidebar floats and two columns that do not fit at their readable minimums go
// to 360 view too: squeezed side by side, neither stays readable.
export const NarrowAutoMinColumns = 2;

export function autoMinColumns(narrowWindow: boolean): number {
    return narrowWindow ? NarrowAutoMinColumns : AutoMinColumns;
}
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

// The minimum of each of `columnCount` top-level columns once the first column's floor (#731, #848) counts: the first
// column at max(readable minimum, floor) whatever it holds, the others at their readable minimum. Without a floor,
// the readable minimums.
export function columnMinimumsPx(columnCount: number, floorPx: number): number[] {
    const floor = floorPx > 0 ? floorPx : 0;
    return readableMinimumsPx(columnCount).map((min, i) => (i === 0 ? Math.max(min, floor) : min));
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
// `columnMins` (columnMinimumsPx) makes the first column count its floor; `minColumns` (autoMinColumns) is where the
// automatic view starts.
export function autoWants(
    prevOn: boolean,
    columnCount: number,
    widthPx: number,
    gapPx = 0,
    columnMins?: number[],
    minColumns = AutoMinColumns
): boolean {
    if (columnCount < minColumns || !(widthPx > 0)) {
        return false;
    }
    const need = minimumsPx(columnCount, gapPx, columnMins);
    if (prevOn) {
        return need + LeaveMarginPx > widthPx;
    }
    return need > widthPx;
}

// Whether the columns fit side by side at their current minimums, first column floor included (#733: leave 360 view as is).
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

// Whether the tab has more top-level columns than the screen's threshold (#1083): "360 view beyond N columns".
export function overThreshold(columnCount: number, threshold: number): boolean {
    return threshold > 0 && columnCount > threshold;
}

export type View360Inputs = {
    setting: View360Setting;
    manual: boolean;
    // The readable-minimum rule (autoWants), the safety net since #1083.
    autoOn: boolean;
    // More columns than this screen's threshold (#1083).
    columnsOver?: boolean;
    // The columns do not fit even at their readable minimums: nothing keeps the normal layout then.
    cannotFit?: boolean;
    columnCount: number;
    // The window is narrow (FR-SHELL-109): two columns go automatic when they cannot fit.
    narrowWindow?: boolean;
};

// What holds an automatic view on: the screen's column threshold, or the readable minimums.
export type View360Reason = "columns" | "fit";

export type View360Decision = { active: boolean; wanted: boolean; source: View360Source; reason?: View360Reason };

// wanted: what the tab asks for whatever its columns (a panel opened then goes to the carpet); active: what is drawn,
// never 360 view for a single column (nothing to lay on the carpet). source: what holds the view on (on demand first,
// then the automatic decision, then the always setting), or while off what keeps it off (the tab's own choice, the
// automatic decision otherwise). Turned off by hand (#1083), the tab stays off beyond the threshold and below the
// first column's floor, only columns that cannot fit at all turn it back on.
export function decideView360(inputs: View360Inputs): View360Decision {
    let wanted = false;
    let source: View360Source = "auto";
    let reason: View360Reason;
    const autoColumns = inputs.columnCount >= autoMinColumns(!!inputs.narrowWindow);
    if (inputs.manual === true) {
        wanted = true;
        source = "manual";
    } else if (inputs.manual === false) {
        wanted = !!inputs.cannotFit && autoColumns;
        source = wanted ? "auto" : "manual";
        reason = wanted ? "fit" : undefined;
    } else if (inputs.columnsOver && inputs.columnCount >= AutoMinColumns) {
        wanted = true;
        reason = "columns";
    } else if (inputs.autoOn && autoColumns) {
        wanted = true;
        reason = "fit";
    } else if (inputs.setting === "always") {
        wanted = true;
        source = "setting";
    }
    const rtn: View360Decision = { active: wanted && inputs.columnCount >= 2, wanted, source };
    if (reason != null) {
        rtn.reason = reason;
    }
    return rtn;
}

// Turning the 360 view off (#733, #1083): "leave" whenever the columns fit at their readable minimums (the remembered
// proportions come back, nothing is readjusted); "blocked" when they do not fit even then, with how many columns are
// too many.
export type View360Exit = { kind: "leave" } | { kind: "blocked"; extraColumns: number };

// How many columns fit side by side at their readable minimums, at least the first one.
export function maxReadableColumns(widthPx: number, gapPx = 0): number {
    let count = 1;
    while (Number.isFinite(widthPx) && minimumsPx(count + 1, gapPx) <= widthPx) {
        count++;
    }
    return count;
}

export function exitView360(columnCount: number, widthPx: number, gapPx = 0): View360Exit {
    if (columnCount < 2 || !(widthPx > 0) || fitsAtReadableMinimums(columnCount, widthPx, gapPx)) {
        return { kind: "leave" };
    }
    return { kind: "blocked", extraColumns: Math.max(1, columnCount - maxReadableColumns(widthPx, gapPx)) };
}

// ---- the developer's proportions (#1083) ------------------------------------------------------------------------

// The share of each top-level column (summing to 1), from the tree's sizes; empty when they cannot be read.
export function columnFractions(sizes: number[]): number[] {
    const clean = (sizes ?? []).map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
    const total = clean.reduce((acc, s) => acc + s, 0);
    if (!(total > 0) || clean.some((s) => s === 0)) {
        return [];
    }
    return clean.map((s) => s / total);
}

// Remembered proportions as stored in the tab's meta: positive shares, at least one; anything else is none.
export function readFractions(raw: unknown): number[] {
    if (!Array.isArray(raw) || raw.length === 0) {
        return null;
    }
    const fractions = columnFractions(raw.map((v) => (typeof v === "number" ? v : NaN)));
    return fractions.length ? fractions : null;
}

export function sameFractions(a: number[], b: number[], tolerance = 0.0005): boolean {
    if (a == null || b == null) {
        return a == b;
    }
    return a.length === b.length && a.every((f, i) => Math.abs(f - b[i]) <= tolerance);
}

// The share a column at `index` takes from remembered proportions: its own while it was there, else the carpet slot,
// the last non-first column's share. Null for the first column without proportions, or when no column beside the
// first was remembered.
export function slotFraction(fractions: number[], index: number): number {
    if (!fractions?.length || index < 0) {
        return null;
    }
    if (index < fractions.length) {
        return fractions[index];
    }
    return fractions.length >= 2 ? fractions[fractions.length - 1] : null;
}

// The tree sizes (summing to 100) that give `count` columns back their remembered proportions: each column its own
// share, a column past the remembered ones the slot's share. Null when nothing is remembered for them.
export function restoredColumnSizes(fractions: number[], count: number): number[] {
    if (!fractions?.length || count < 2) {
        return null;
    }
    const shares = Array.from({ length: count }, (_, i) => slotFraction(fractions, i));
    if (shares.some((s) => s == null)) {
        return null;
    }
    const total = shares.reduce((acc, s) => acc + s, 0);
    return shares.map((s) => (s / total) * 100);
}

// The fixed zone's width in 360 view from remembered proportions: what the first column took in the normal layout.
export function rememberedFixedPx(fractions: number[], widthPx: number, gapPx = 0): number {
    if (!fractions?.length || fractions.length < 2 || !(widthPx > 0)) {
        return null;
    }
    const room = widthPx - Math.max(0, gapPx || 0) * (fractions.length - 1);
    return room > 0 ? fractions[0] * room : null;
}

// The width each carpet column takes from remembered proportions: the columns beside the first share the carpet as
// they shared the rest of the normal layout (40/60: the carpet panel at the whole carpet; 30/35/35: two panels side by
// side), a column past the remembered ones at the slot's width. `indexes` are the columns' places among the tab's
// top-level columns (1 for the first one beside the fixed zone). Null when no column beside the first was remembered.
export function carpetSlotWidthsPx(fractions: number[], indexes: number[], viewportPx: number, gapPx = 0): number[] {
    if (!fractions || fractions.length < 2 || !(viewportPx > 0)) {
        return null;
    }
    const side = fractions.slice(1);
    const sideTotal = side.reduce((acc, f) => acc + f, 0);
    const room = viewportPx - Math.max(0, gapPx || 0) * (side.length - 1);
    if (!(sideTotal > 0) || !(room > 0)) {
        return null;
    }
    return indexes.map((i) => (slotFraction(fractions, Math.max(1, i)) / sideTotal) * room);
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
