// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The previous / next carpet panel shortcuts (FR-SHELL-068-AC3): in 360 view they move the carpet one panel at a time
// and focus that panel. Outside 360 view they leave the key to the focused panel.

import { globalStore } from "@/app/store/jotaiStore";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { getLayoutModelForStaticTab } from "@/layout/lib/layoutModelHooks";
import { findShortcut } from "../shortcuts/registry";
import { buildRadarTicks, stepCarpetColumn } from "./radar-model";
import { makeRadarFactsAtom, radarColumns } from "./radar-store";

export const CarpetPreviousShortcutId = "carpet-previous";
export const CarpetNextShortcutId = "carpet-next";

// Returns false when the tab is not in 360 view or there is nowhere to go, so the key goes on to the panel.
export function stepCarpet(layoutModel: LayoutModel, dir: -1 | 1): boolean {
    const view360 = layoutModel?.moltenView360;
    const layout = view360?.layout;
    const rootNode = layoutModel?.treeState?.rootNode;
    if (layout == null || rootNode == null || layout.columns.length === 0) {
        return false;
    }
    const focused = globalStore.get(layoutModel.focusedNode);
    const current = focused == null ? null : view360.carpetColumnOf(focused.id);
    const visibleIds = globalStore.get(view360.visibleColumnIdsAtom);
    const columnIds = layout.columns.map((c) => c.nodeId);
    const target = stepCarpetColumn(columnIds, current, dir, visibleIds);
    if (target == null) {
        return current != null;
    }
    const columns = radarColumns(rootNode, layout);
    const blockIds = columns.flatMap((c) => c.leaves.map((l) => l.blockId));
    const ticks = buildRadarTicks(columns, globalStore.get(makeRadarFactsAtom(blockIds)), visibleIds);
    const tick = ticks.find((t) => t.columnId === target);
    view360.scrollToColumn(target);
    if (tick != null) {
        layoutModel.focusNode(tick.focusNodeId);
    }
    return true;
}

export function registerCarpetKeys(keyMap: Map<string, (e: WaveKeyboardEvent) => boolean>) {
    const bind = (id: string, dir: -1 | 1) => {
        const shortcut = findShortcut(id);
        if (shortcut == null) {
            return;
        }
        for (const keys of [shortcut.keys, ...(shortcut.alt ?? [])]) {
            keyMap.set(keys, () => stepCarpet(getLayoutModelForStaticTab(), dir));
        }
    };
    bind(CarpetPreviousShortcutId, -1);
    bind(CarpetNextShortcutId, 1);
}
