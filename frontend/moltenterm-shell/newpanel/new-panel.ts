// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// ⌘T, "New panel" (FR-SHELL-086, #1241, #1742): carries out new-panel-model.ts on the tab on screen.

import { createBlock, getSettingsKeyAtom, globalStore } from "@/app/store/global";
import { ObjectService } from "@/app/store/services";
import type { LayoutTreeResizeNodeAction } from "@/layout/index";
import { getLayoutModelForStaticTab, LayoutTreeActionType, newLayoutNode } from "@/layout/index";
import type { LayoutTreeSplitHorizontalAction } from "@/layout/lib/types";
import { fireAndForget } from "@/util/util";
import { rowEqualizeOps } from "../equalize/equalize-rules";
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
    const under = findPanelUnderPointer();
    const target = newPanelTarget(under?.hit, under?.x, placementFallbackBlockId());
    const layoutModel = getLayoutModelForStaticTab();
    if (target == null || layoutModel?.getNodeByBlockId(target.blockId) == null) {
        await createBlock(blockdef);
        return;
    }
    const newBlockId = await ObjectService.CreateBlock(blockdef, { termsize: NewPanelTermSize });
    // Read after the await: the layout may have changed while the block was created.
    const node = layoutModel.getNodeByBlockId(target.blockId);
    const rootNode = layoutModel.treeState?.rootNode;
    const view360 = layoutModel.moltenView360;
    const split =
        node == null
            ? null
            : newPanelSplit(rootNode, node.id, target.side, view360?.layout ?? null, view360?.wanted ?? false);
    if (split == null) {
        fireAndForget(() => ObjectService.DeleteBlock(newBlockId));
        return;
    }
    // A magnified panel hides the others: the new panel would open out of sight.
    if (layoutModel.magnifiedNodeId != null) {
        layoutModel.magnifyNodeToggle(layoutModel.magnifiedNodeId, false);
    }
    const newNode = newLayoutNode(undefined, undefined, undefined, { blockId: newBlockId });
    const action: LayoutTreeSplitHorizontalAction = {
        type: LayoutTreeActionType.SplitHorizontal,
        targetNodeId: split.targetNodeId,
        newNode,
        position: split.position,
        focused: true,
    };
    if (!split.equalizeRow) {
        layoutModel.treeReducer(action);
        return;
    }
    // Both actions before the layout is drawn: no frame with the row uneven.
    layoutModel.treeReducer(action, false);
    layoutModel.treeReducer({
        type: LayoutTreeActionType.ResizeNode,
        resizeOperations: rowEqualizeOps(layoutModel.treeState?.rootNode, newNode.id),
    } as LayoutTreeResizeNodeAction);
}
