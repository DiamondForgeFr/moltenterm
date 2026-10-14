// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// When a tab shows in 360 view (FR-SHELL-066, DS-SHELL-116): the setting moltenterm:view360, the tab's manual choice,
// and in automatic the readable minimum of every column against the tab's width, with a margin before leaving so a
// window dragged around the threshold does not flap. Pure rules, kept apart from the layout so they are tested alone.

import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { FixedMinPx } from "./carpet-model";

export const View360SettingKey = "moltenterm:view360";

// The readable minimums (tunable): the first column, the same as the fixed zone's minimum, and any other column.
export const FirstColumnMinPx = FixedMinPx;
export const SideColumnMinPx = 360;
// Automatic leaves 360 view only once every column fits at its minimum with this much to spare.
export const LeaveMarginPx = 64;
// A width change alone (the window being resized) switches only once the width has held this long.
export const ResizeSettleMs = 250;

export type View360Setting = "auto" | "always" | "never";
// Where the tab's state comes from: its own toggle, the always / never setting, or the automatic decision.
export type View360Source = "manual" | "setting" | "auto";

export function normalizeView360Setting(raw: unknown): View360Setting {
    return raw === "always" || raw === "never" ? raw : "auto";
}

// The tab's manual choice, from its meta: true on, false off, null when it follows the setting.
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

export function columnMinPx(index: number): number {
    return index === 0 ? FirstColumnMinPx : SideColumnMinPx;
}

// The width every column needs at its readable minimum, gaps included.
export function minimumsPx(columnCount: number, gapPx = 0): number {
    if (columnCount <= 0) {
        return 0;
    }
    return FirstColumnMinPx + (columnCount - 1) * (SideColumnMinPx + Math.max(0, gapPx || 0));
}

// The automatic decision: enter when the minimums no longer fit, leave only when they fit with the margin.
export function autoWants(prevOn: boolean, columnCount: number, widthPx: number, gapPx = 0): boolean {
    if (columnCount < 2 || !(widthPx > 0)) {
        return false;
    }
    const need = minimumsPx(columnCount, gapPx);
    if (prevOn) {
        return need + LeaveMarginPx > widthPx;
    }
    return need > widthPx;
}

export type View360Inputs = {
    setting: View360Setting;
    manual: boolean;
    autoOn: boolean;
    columnCount: number;
};

export type View360Decision = { active: boolean; wanted: boolean; source: View360Source };

// wanted: what the tab asks for whatever its columns (a panel opened then goes to the carpet); active: what is drawn,
// never 360 view for a single column (nothing to lay on the carpet).
export function decideView360(inputs: View360Inputs): View360Decision {
    let wanted: boolean;
    let source: View360Source;
    if (inputs.manual != null) {
        wanted = inputs.manual;
        source = "manual";
    } else if (inputs.setting === "always" || inputs.setting === "never") {
        wanted = inputs.setting === "always";
        source = "setting";
    } else {
        wanted = !!inputs.autoOn;
        source = "auto";
    }
    return { active: wanted && inputs.columnCount >= 2, wanted, source };
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

export function anyColumnTooTight(columnPxs: number[]): boolean {
    if (columnPxs.length < 2) {
        return false;
    }
    // Half a pixel of rounding is not "too tight".
    return columnPxs.some((px, i) => px + 0.5 < columnMinPx(i));
}

export type TightPillInputs = {
    setting: View360Setting;
    manual: boolean;
    active: boolean;
    tooTight: boolean;
    dismissed: boolean;
};

// The pill shows when the developer refused the 360 view (never mode, or this tab toggled off) and a column is under
// its minimum; the automatic and always modes switch instead.
export function showTightPill(inputs: TightPillInputs): boolean {
    if (inputs.active || !inputs.tooTight || inputs.dismissed) {
        return false;
    }
    return inputs.manual === false || (inputs.manual == null && inputs.setting === "never");
}
