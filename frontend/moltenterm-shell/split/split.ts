// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Split any panel, then choose its content (FR-SHELL-042, DS-SHELL-064): one entry point for the edge handles, the
// menus, Cmd+D / Cmd+Shift+D and the Ctrl+Shift+S chord. The new panel opens on the picker (the command palette in
// pane mode, DS-SHELL-066); cancelling it removes the panel and gives its room back to the source.

import { getFocusedBlockId, WOS } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { ObjectService } from "@/app/store/services";
import type { LayoutTreeResizeNodeAction } from "@/layout/index";
import { getLayoutModelForStaticTab, LayoutTreeActionType, newLayoutNode } from "@/layout/index";
import { findParent } from "@/layout/lib/layoutNode";
import type { LayoutTreeSplitHorizontalAction, LayoutTreeSplitVerticalAction } from "@/layout/lib/types";
import { fireAndForget } from "@/util/util";
import { HalfSplit, splitAxis, SplitDirection, SplitFromMetaKey, splitSizes } from "./split-model";

// The pickers opened by a split and not chosen or cancelled yet (new block id -> source block id). Not persisted: a
// picker left open across a restart still cancels, from its block meta.
const pendingSplits = new Map<string, string>();

export function splitPickerBlockDef(sourceBlockId: string): BlockDef {
    return { meta: { view: "launcher", [SplitFromMetaKey]: sourceBlockId } as MetaType };
}

export function readSplitFrom(blockId: string): string {
    if (!blockId) {
        return null;
    }
    const meta = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)))?.meta as Record<
        string,
        unknown
    >;
    const from = meta?.[SplitFromMetaKey];
    return typeof from === "string" && from !== "" ? from : null;
}

// Pickers whose panel was closed another way (Cmd+W, the close button) are forgotten.
function prunePendingSplits() {
    const layoutModel = getLayoutModelForStaticTab();
    for (const blockId of [...pendingSplits.keys()]) {
        if (layoutModel?.getNodeByBlockId(blockId) == null) {
            pendingSplits.delete(blockId);
        }
    }
}

// Splits the panel and opens the picker in the new one; fraction is the new panel's share of the source (the handles
// pass the dragged size, every other way a half). Returns the new block id, null when the panel is not in the layout.
export async function splitPanel(
    sourceBlockId: string,
    direction: SplitDirection,
    fraction = HalfSplit
): Promise<string> {
    const layoutModel = getLayoutModelForStaticTab();
    if (layoutModel == null || !sourceBlockId || layoutModel.getNodeByBlockId(sourceBlockId) == null) {
        return null;
    }
    prunePendingSplits();
    const newBlockId = await ObjectService.CreateBlock(splitPickerBlockDef(sourceBlockId), {
        termsize: { rows: 25, cols: 80 },
    });
    // Read after the await: the layout may have changed while the block was created.
    if (layoutModel.getNodeByBlockId(sourceBlockId) == null) {
        fireAndForget(() => ObjectService.DeleteBlock(newBlockId));
        return null;
    }
    pendingSplits.set(newBlockId, sourceBlockId);
    insertBlockBeside(sourceBlockId, direction, newBlockId, fraction);
    return newBlockId;
}

// Lays an existing block out beside a panel of the shown tab, focused, taking its share of the panel's size (a drop
// on a panel, FR-SHELL-060, and the split above). Returns false when the panel is not in the layout.
export function insertBlockBeside(
    targetBlockId: string,
    direction: SplitDirection,
    newBlockId: string,
    fraction = HalfSplit
): boolean {
    const layoutModel = getLayoutModelForStaticTab();
    const source = layoutModel?.getNodeByBlockId(targetBlockId);
    if (source == null || !newBlockId) {
        return false;
    }
    // A magnified panel hides the others: the new panel would open out of sight.
    if (layoutModel.magnifiedNodeId != null) {
        layoutModel.magnifyNodeToggle(layoutModel.magnifiedNodeId, false);
    }
    const sizes = splitSizes(source.size, fraction);
    const { axis, position } = splitAxis(direction);
    const newNode = newLayoutNode(undefined, sizes.added, undefined, { blockId: newBlockId });
    const splitAction: LayoutTreeSplitHorizontalAction | LayoutTreeSplitVerticalAction = {
        type: axis === "horizontal" ? LayoutTreeActionType.SplitHorizontal : LayoutTreeActionType.SplitVertical,
        targetNodeId: source.id,
        newNode,
        position,
        focused: true,
    } as LayoutTreeSplitHorizontalAction | LayoutTreeSplitVerticalAction;
    // Both actions before the layout is drawn: no 50/50 frame before the dragged size.
    layoutModel.treeReducer(splitAction, false);
    layoutModel.treeReducer({
        type: LayoutTreeActionType.ResizeNode,
        resizeOperations: [{ nodeId: source.id, size: sizes.source }],
    } as LayoutTreeResizeNodeAction);
    return true;
}

// The focused panel, for the keys (Cmd+D, Cmd+Shift+D, the Ctrl+Shift+S chord).
export function splitFocusedPanel(direction: SplitDirection): void {
    const blockId = getFocusedBlockId();
    if (!blockId) {
        return;
    }
    fireAndForget(() => splitPanel(blockId, direction));
}

// The picker's entry was chosen: the panel stays, whatever it becomes.
export function consumeSplit(newBlockId: string): void {
    pendingSplits.delete(newBlockId);
}

export function isPendingSplit(newBlockId: string): boolean {
    return pendingSplits.has(newBlockId);
}

// Escape, a click away, or an entry that opens nothing in the panel (DS-SHELL-066): the new panel goes and its room
// returns to the source, which gets the focus unless keepFocus. Returns false when the picker is the tab's last panel.
export async function cancelSplit(newBlockId: string, keepFocus = false): Promise<boolean> {
    const layoutModel = getLayoutModelForStaticTab();
    const node = layoutModel?.getNodeByBlockId(newBlockId);
    const sourceBlockId = pendingSplits.get(newBlockId) ?? readSplitFrom(newBlockId);
    pendingSplits.delete(newBlockId);
    if (node == null) {
        return false;
    }
    const root = layoutModel.treeState?.rootNode;
    if (root == null || root.id === node.id) {
        return false;
    }
    const source = sourceBlockId ? layoutModel.getNodeByBlockId(sourceBlockId) : null;
    // Siblings: the source takes the picker's share back, whatever happened to the sizes since the split. When the split
    // had wrapped the source in a new group, Wave folds the group back into it with the group's size.
    const parent = findParent(root, node.id);
    const giveBack = source != null && parent?.children?.some((child) => child.id === source.id);
    if (giveBack) {
        layoutModel.treeReducer(
            {
                type: LayoutTreeActionType.ResizeNode,
                // Wave's resize refuses sizes over 100.
                resizeOperations: [{ nodeId: source.id, size: Math.min(source.size + node.size, 100) }],
            } as LayoutTreeResizeNodeAction,
            false
        );
    }
    await layoutModel.closeNode(node.id);
    if (keepFocus || sourceBlockId == null) {
        return true;
    }
    const after = layoutModel.getNodeByBlockId(sourceBlockId);
    if (after != null) {
        layoutModel.focusNode(after.id);
    }
    return true;
}
