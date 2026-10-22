// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Panels that run hidden (#916, DS-REV-012): a block of the tab kept outside the layout, such as the review session's
// terminal, whose agent works while the AI panel shows its cards. The layout spares it when it cleans up orphaned
// blocks; showing it lays it out beside a panel (or at the end) and focuses it, and from then on it is an ordinary
// panel.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab, LayoutTreeActionType, newLayoutNode } from "@/layout/index";
import type { LayoutTreeInsertNodeAction, LayoutTreeSplitVerticalAction } from "@/layout/lib/types";
import { fireAndForget } from "@/util/util";
import { HiddenMetaKey, isHiddenMeta } from "./hidden-panel-meta";

function blockMeta(blockId: string): MetaType {
    return globalStore.get(getWaveObjectAtom<Block>(makeORef("block", blockId)))?.meta;
}

// Focuses a panel of the shown tab, laying it out first when it runs hidden: split under underBlockId when that panel
// is laid out, else added. Returns false when the block is neither laid out nor a hidden panel of this layout's tab.
export function showPanel(blockId: string, underBlockId?: string): boolean {
    const layoutModel = getLayoutModelForStaticTab();
    if (layoutModel == null || !blockId) {
        return false;
    }
    const node = layoutModel.getNodeByBlockId(blockId);
    if (node != null) {
        layoutModel.focusNode(node.id);
        return true;
    }
    // A tab just shown may not have its layout yet: the caller tries again rather than lay out an empty tree.
    if (layoutModel.treeState?.rootNode == null) {
        return false;
    }
    const tab = globalStore.get(getWaveObjectAtom<Tab>(makeORef("tab", globalStore.get(atoms.staticTabId))));
    if (!(tab?.blockids ?? []).includes(blockId) || !isHiddenMeta(blockMeta(blockId))) {
        return false;
    }
    // A magnified panel hides the others: the shown one would open out of sight.
    if (layoutModel.magnifiedNodeId != null) {
        layoutModel.magnifyNodeToggle(layoutModel.magnifiedNodeId, false);
    }
    const newNode = newLayoutNode(undefined, undefined, undefined, { blockId });
    const under = underBlockId ? layoutModel.getNodeByBlockId(underBlockId) : null;
    if (under != null) {
        layoutModel.treeReducer({
            type: LayoutTreeActionType.SplitVertical,
            targetNodeId: under.id,
            newNode,
            position: "after",
            focused: true,
        } as LayoutTreeSplitVerticalAction);
    } else {
        layoutModel.treeReducer({
            type: LayoutTreeActionType.InsertNode,
            node: newNode,
            focused: true,
        } as LayoutTreeInsertNodeAction);
    }
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: makeORef("block", blockId),
            meta: { [HiddenMetaKey]: null } as MetaType,
        })
    );
    return true;
}
