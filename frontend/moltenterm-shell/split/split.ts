// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Split any panel, then choose its content (FR-SHELL-042, DS-SHELL-064): one entry point for the edge handles, the
// menus, Cmd+D / Cmd+Shift+D and the Ctrl+Shift+S chord. The new panel opens on the picker (the command palette in
// pane mode, DS-SHELL-066); cancelling it removes the panel and gives the source its size back.

import { getFocusedBlockId, WOS } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { ObjectService } from "@/app/store/services";
import type { LayoutTreeResizeNodeAction } from "@/layout/index";
import { getLayoutModelForStaticTab, LayoutTreeActionType, newLayoutNode } from "@/layout/index";
import type { LayoutTreeSplitHorizontalAction, LayoutTreeSplitVerticalAction } from "@/layout/lib/types";
import { fireAndForget } from "@/util/util";
import { HalfSplit, splitAxis, SplitDirection, SplitFromMetaKey, splitSizes } from "./split-model";

type PendingSplit = { sourceBlockId: string; sourceSize: number };

// The pickers opened by a split, by new block id, until the user chooses (consumeSplit) or cancels (cancelSplit).
// Not persisted: a picker left open across a restart cancels by closing its panel, the sizes stay as they are.
const pendingSplits = new Map<string, PendingSplit>();

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

export function blockMeta(blockId: string): MetaType {
    if (!blockId) {
        return null;
    }
    return globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)))?.meta;
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
    const newBlockId = await ObjectService.CreateBlock(splitPickerBlockDef(sourceBlockId), {
        termsize: { rows: 25, cols: 80 },
    });
    // Read after the await: the layout may have changed while the block was created.
    const source = layoutModel.getNodeByBlockId(sourceBlockId);
    if (source == null) {
        fireAndForget(() => ObjectService.DeleteBlock(newBlockId));
        return null;
    }
    const sourceSize = source.size;
    const sizes = splitSizes(sourceSize, fraction);
    const { axis, position } = splitAxis(direction);
    const newNode = newLayoutNode(undefined, sizes.added, undefined, { blockId: newBlockId });
    const splitAction: LayoutTreeSplitHorizontalAction | LayoutTreeSplitVerticalAction = {
        type: axis === "horizontal" ? LayoutTreeActionType.SplitHorizontal : LayoutTreeActionType.SplitVertical,
        targetNodeId: source.id,
        newNode,
        position,
        focused: true,
    } as LayoutTreeSplitHorizontalAction | LayoutTreeSplitVerticalAction;
    pendingSplits.set(newBlockId, { sourceBlockId, sourceSize });
    // Both actions before the layout is drawn: no 50/50 frame before the dragged size.
    layoutModel.treeReducer(splitAction, false);
    layoutModel.treeReducer({
        type: LayoutTreeActionType.ResizeNode,
        resizeOperations: [{ nodeId: source.id, size: sizes.source }],
    } as LayoutTreeResizeNodeAction);
    return newBlockId;
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

// Escape or a click away before choosing (DS-SHELL-066): the new panel goes, the source gets its size back and, unless
// keepFocus, the focus. Returns false when there is nothing to cancel (the picker is the tab's last panel).
export async function cancelSplit(newBlockId: string, keepFocus = false): Promise<boolean> {
    const layoutModel = getLayoutModelForStaticTab();
    const node = layoutModel?.getNodeByBlockId(newBlockId);
    if (node == null) {
        pendingSplits.delete(newBlockId);
        return false;
    }
    const pending = pendingSplits.get(newBlockId);
    pendingSplits.delete(newBlockId);
    const sourceBlockId = pending?.sourceBlockId ?? readSplitFrom(newBlockId);
    if (sourceBlockId == null || layoutModel.getNodeByBlockId(sourceBlockId) == null) {
        return false;
    }
    await layoutModel.closeNode(node.id);
    // Wave folds a group left with one panel into it, under the panel's id: look the source up again.
    const source = layoutModel.getNodeByBlockId(sourceBlockId);
    if (source == null) {
        return true;
    }
    if (pending != null && source.size !== pending.sourceSize) {
        layoutModel.treeReducer({
            type: LayoutTreeActionType.ResizeNode,
            resizeOperations: [{ nodeId: source.id, size: pending.sourceSize }],
        } as LayoutTreeResizeNodeAction);
    }
    if (!keepFocus) {
        layoutModel.focusNode(source.id);
    }
    return true;
}
