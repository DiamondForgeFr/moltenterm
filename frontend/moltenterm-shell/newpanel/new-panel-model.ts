// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// ⌘T, "New panel" (FR-SHELL-086, #1241, #1742): a new panel beside the panel under the mouse pointer, on the side of it
// nearest the pointer, holding what a new view starts with (FR-SHELL-089) with the type of the focused panel selected,
// then the row it joined evened out. The rules as pure functions, tested without the app; new-panel.ts carries them out.

import type { LayoutNode } from "@/layout/lib/types";
import {
    newViewStart,
    panelChooserBlockDef,
    preselectEntryId,
    resolveDirect,
    TerminalChoiceId,
} from "../newview/new-view-model";
import type { PaletteEntry, PaletteRun } from "../palette/palette-model";
import { besidePlace, type BesideSide } from "../split/add-beside-model";
import type { CarpetLayout } from "../view360/carpet-model";

// The panel found under the pointer when ⌘T is pressed, with its box's horizontal extent.
export type PointerHit = { blockId: string; left: number; width: number };

export type NewPanelTarget = { blockId: string; side: BesideSide };

// Where the split lands, and whether the row it joins is evened out afterwards (never on the 360 carpet, which
// scrolls: its columns keep their widths).
export type NewPanelSplit = { targetNodeId: string; position: "before" | "after"; equalizeRow: boolean };

// What the new panel holds: a block, today's terminal (its directory and connection come from the panel the key was
// pressed in), or an entry that opens nothing in a panel (Sessions, the Project tab), which just runs.
export type NewPanelContent =
    | { kind: "block"; blockdef: BlockDef }
    | { kind: "terminal" }
    | { kind: "run"; run: PaletteRun };

// The half of the panel's box the pointer is in.
export function pointerSide(hit: PointerHit, pointerX: number): BesideSide {
    return pointerX < hit.left + hit.width / 2 ? "left" : "right";
}

// The panel the new one goes beside: the one under the pointer, on the side nearest it; with the pointer over no
// panel (outside the window, over the sidebar), the focused one, on its right. Null when there is neither.
export function newPanelTarget(hit: PointerHit, pointerX: number, focusedBlockId: string): NewPanelTarget {
    if (hit?.blockId && hit.width > 0 && Number.isFinite(pointerX)) {
        return { blockId: hit.blockId, side: pointerSide(hit, pointerX) };
    }
    return focusedBlockId ? { blockId: focusedBlockId, side: "right" } : null;
}

// The split for a panel of node nodeId. In the normal layout, a split of the panel itself, so the new one joins its
// row (or makes one with it) and that row is evened out. In 360 view (layout set), a new top-level column beside the
// carpet column holding it; over the fixed zone, where nothing goes before it, the start of the carpet. A tab wanting
// 360 view but not drawn in it yet lets the 360 view lay the split out (rewriteAction), without evening anything.
export function newPanelSplit(
    root: LayoutNode,
    nodeId: string,
    side: BesideSide,
    layout: CarpetLayout,
    wants360: boolean
): NewPanelSplit {
    if (root == null || !nodeId) {
        return null;
    }
    const position = side === "left" ? "before" : "after";
    if (layout == null) {
        return { targetNodeId: nodeId, position, equalizeRow: !wants360 };
    }
    const place = besidePlace(root, nodeId, side, layout) ?? besidePlace(root, nodeId, "right", layout);
    return place == null ? null : { targetNodeId: place.targetNodeId, position: place.position, equalizeRow: false };
}

// What the new panel holds, from "When a new view opens" (app:newviewopen): the chooser by default, the type set to
// open directly otherwise, Terminal giving back the terminal the new panel key always opened. The chooser selects the type of the
// panel the focus is in (focusedView, #1742); a type set to open directly is the developer's explicit choice and wins.
export function newPanelContent(setting: unknown, choices: PaletteEntry[], focusedView?: string): NewPanelContent {
    const direct = resolveDirect(setting, choices);
    if (direct?.id === TerminalChoiceId) {
        return { kind: "terminal" };
    }
    if (direct == null) {
        return { kind: "block", blockdef: panelChooserBlockDef(preselectEntryId(focusedView, choices)) };
    }
    const start = newViewStart(direct);
    return start.kind === "tab" ? { kind: "block", blockdef: start.blockdef } : { kind: "run", run: start.run };
}

// The focus when ⌘T is pressed: the panel the key came from (a page's key is sent back with its page, whatever panel
// the layout believes focused), else the panel holding the keyboard focus, else the layout's focused panel. The
// workspace sidebar holding the focus is no panel (#1742).
export type PanelFocusFacts = {
    originBlockId?: string;
    inSidebar: boolean;
    domBlockId?: string;
    layoutBlockId?: string;
};

export function focusedPanelBlockId(facts: PanelFocusFacts): string {
    if (facts.originBlockId) {
        return facts.originBlockId;
    }
    if (facts.inSidebar) {
        return null;
    }
    return facts.domBlockId || facts.layoutBlockId || null;
}
