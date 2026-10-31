// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A workspace's blocks as its sidebar shows them (FR-SHELL-080, FR-SHELL-088, #1307): the top row, the views pinned
// everywhere in the pins' order with the pin's name and glyph (identical in every workspace, #1270), then the
// workspace's tiles in its order. The sidebar and the library's workspace cards both read it, so they cannot drift.
// The pins' names and glyphs come from the pins, never from a workspace's instance: an instance takes a rename or an
// "Update the pinned view" (#1272) only when it is next opened.

import type { SidebarTabSplit } from "./sidebar-model";
import { configPaneIcons, viewGlyphIcons } from "./view-menu-model";
import type { GlobalPin } from "./view-pins-model";

// The top row's lines (FR-SHELL-080, #1651): up to four blocks a line, a 6 px gutter. A line whose blocks each get at
// least 88 px shows each name beside its icon; at least 52 px, under it, as tiles do (four views at the default
// sidebar width); narrower, only its active block keeps its name, the others show their icon.
export const TopRowPerLine = 4;
export const TopRowGap = 6;
export const TopRowBesideMinWidth = 88;
export const TopRowStackedMinWidth = 52;
// An inactive block of a line too narrow for names: the width of its icon, as the row's blocks were before #1651.
export const TopRowIconWidth = 40;

// tabId: this workspace's instance of the pin, "" when the workspace never opened it.
export type TopRowBlock = { pin: GlobalPin; tabId: string; name: string; glyph: string[] };

export type WorkspaceBlocks = { top: TopRowBlock[]; tiles: string[] };

// A top-row block's glyph: its pin's icon, else the pin's configuration.
export function pinGlyph(pin: GlobalPin): string[] {
    return viewGlyphIcons(pin.icon, configPaneIcons(pin.config));
}

export function topRowBlocks(pins: readonly GlobalPin[], instances: Record<string, string>): TopRowBlock[] {
    return (pins ?? []).map((pin) => ({
        pin,
        tabId: instances?.[pin.id] ?? "",
        name: pin.name,
        glyph: pinGlyph(pin),
    }));
}

export function topRowLines<T>(blocks: readonly T[]): T[][] {
    const lines: T[][] = [];
    for (let i = 0; i < (blocks?.length ?? 0); i += TopRowPerLine) {
        lines.push(blocks.slice(i, i + TopRowPerLine));
    }
    return lines;
}

export type TopRowLineFit = "beside" | "stacked" | "narrow";

// How a line of `count` blocks shows names in a row `width` px wide. Not yet measured, beside.
export function topRowLineFit(width: number, count: number): TopRowLineFit {
    if (!(width > 0) || !(count > 0)) {
        return "beside";
    }
    const each = (width - TopRowGap * (count - 1)) / count;
    if (each >= TopRowBesideMinWidth) {
        return "beside";
    }
    return each >= TopRowStackedMinWidth ? "stacked" : "narrow";
}

// A block shows its name unless its line is narrow and it is not the line's active block: that one keeps its name
// and takes the room the others free; they keep the name in their tooltip and accessible name.
export function topRowShowsName(fit: TopRowLineFit, active: boolean): boolean {
    return fit !== "narrow" || active;
}

export function workspaceBlocks(pins: readonly GlobalPin[], split: SidebarTabSplit): WorkspaceBlocks {
    return { top: topRowBlocks(pins, split?.everywhere ?? {}), tiles: split?.tiles ?? [] };
}
