// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Add a panel" at an end of the carpet (#702, FR-SHELL-065): a new carpet column at that end, opening on the picker
// of a split (FR-SHELL-042, DS-SHELL-066), focused; the layout then glides the carpet to it.

import { getFocusedBlockId } from "@/app/store/global";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { findNode } from "@/layout/lib/layoutNode";
import { addPickerColumn } from "../split/split";
import { CarpetEnd, carpetInsertPlace, columnLeadLeaf } from "./carpet-model";

// The panel the picker takes its context from: the column beside the new one, else the focused panel.
function neighbourBlockId(layoutModel: LayoutModel, targetNodeId: string): string {
    const rootNode = layoutModel.treeState?.rootNode;
    const target = rootNode == null ? null : findNode(rootNode, targetNodeId);
    return columnLeadLeaf(target)?.data?.blockId ?? getFocusedBlockId() ?? null;
}

export async function addCarpetPanel(layoutModel: LayoutModel, end: CarpetEnd): Promise<string> {
    const view360 = layoutModel?.moltenView360;
    if (view360?.layout == null) {
        return null;
    }
    const place = () => carpetInsertPlace(layoutModel.treeState?.rootNode, view360.layout, end);
    const first = place();
    if (first == null) {
        return null;
    }
    return addPickerColumn(layoutModel, neighbourBlockId(layoutModel, first.targetNodeId), place);
}
