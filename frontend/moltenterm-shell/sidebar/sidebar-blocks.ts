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

export function workspaceBlocks(pins: readonly GlobalPin[], split: SidebarTabSplit): WorkspaceBlocks {
    return { top: topRowBlocks(pins, split?.everywhere ?? {}), tiles: split?.tiles ?? [] };
}
