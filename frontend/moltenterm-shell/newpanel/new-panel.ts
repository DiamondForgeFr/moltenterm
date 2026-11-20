// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// ⌘T, "New panel" (FR-SHELL-086, #1241, #1742): carries out new-panel-model.ts on the tab on screen.

import { createBlock, getSettingsKeyAtom, globalStore } from "@/app/store/global";
import { ObjectService } from "@/app/store/services";
import { getLayoutModelForStaticTab, LayoutTreeActionType, newLayoutNode } from "@/layout/index";
import type { LayoutTreeInsertNodeAction, LayoutTreeSplitHorizontalAction } from "@/layout/lib/types";
import { fireAndForget } from "@/util/util";
import { currentNewViewChoices } from "../newview/new-view";
import { NewViewOpenKey } from "../newview/new-view-model";
import { runPaletteEntry } from "../palette/palette-actions";
import { currentFocusedView, placementFallbackBlockId } from "./new-panel-focus";
import { newPanelContent, newPanelSplit, newPanelTarget } from "./new-panel-model";
import { findPanelUnderPointer } from "./pointer-tracker";

const NewPanelTermSize = { rows: 25, cols: 80 };

// terminalDef: the terminal a new panel opens as when Terminal is set to open directly (keymodel.ts), read when the
// panel opens. The focus is read first: nothing awaited before it may move it.
export async function openNewPanel(terminalDef: () => BlockDef): Promise<void> {
    const content = newPanelContent(
        globalStore.get(getSettingsKeyAtom(NewViewOpenKey)),
        currentNewViewChoices(),
        currentFocusedView()
    );
    if (content.kind === "run") {
        await runPaletteEntry(content.run, { placement: "new", blockId: null });
        return;
    }
    const blockdef = content.kind === "terminal" ? terminalDef() : content.blockdef;
    const layoutModel = getLayoutModelForStaticTab();
    // Under a 360 × N the panel goes next to the focused one, whatever is under the pointer (FR-SHELL-123-AC17): the
    // 360 view picks the side and keeps its zones (View360Model.rewriteAction).
    const zones = layoutModel?.moltenView360?.addMode() === "zones";
    const under = zones ? null : findPanelUnderPointer();
    const target = newPanelTarget(under?.hit, under?.x, placementFallbackBlockId());
    if (target == null || layoutModel?.getNodeByBlockId(target.blockId) == null) {
        await createBlock(blockdef);
        return;
    }
    const newBlockId = await ObjectService.CreateBlock(blockdef, { termsize: NewPanelTermSize });
    // Read after the await: the layout may have changed while the block was created.
    const node = layoutModel.getNodeByBlockId(target.blockId);
    const rootNode = layoutModel.treeState?.rootNode;
    const view360 = layoutModel.moltenView360;
    const split = node == null ? null : newPanelSplit(rootNode, node.id, target.side, view360?.layout ?? null);
    if (split == null) {
        fireAndForget(() => ObjectService.DeleteBlock(newBlockId));
        return;
    }
    // A magnified panel hides the others: the new panel would open out of sight.
    if (layoutModel.magnifiedNodeId != null) {
        layoutModel.magnifyNodeToggle(layoutModel.magnifiedNodeId, false);
    }
    const newNode = newLayoutNode(undefined, undefined, undefined, { blockId: newBlockId });
    if (layoutModel.moltenView360?.addMode() === "zones") {
        layoutModel.treeReducer({
            type: LayoutTreeActionType.InsertNode,
            node: newNode,
            focused: true,
        } as LayoutTreeInsertNodeAction);
        return;
    }
    // The siblings of the new panel share their row (LayoutModel.treeReducer, add-panel.ts).
    layoutModel.treeReducer({
        type: LayoutTreeActionType.SplitHorizontal,
        targetNodeId: split.targetNodeId,
        newNode,
        position: split.position,
        focused: true,
    } as LayoutTreeSplitHorizontalAction);
}
