// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Panel size memory (#606), wired to the layout: a dragged splitter records the size of the side panels it moved, in
// the client's meta like the companion's choices (the same for every tab and window, kept across restarts); a side
// panel added to a layout takes the size remembered for its kind.

import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { findNode, findParent } from "@/layout/lib/layoutNode";
import {
    FlexDirection,
    LayoutNode,
    LayoutTreeAction,
    LayoutTreeActionType,
    LayoutTreeInsertNodeAction,
    LayoutTreeInsertNodeAtIndexAction,
    LayoutTreeResizeNodeAction,
    LayoutTreeSplitHorizontalAction,
    LayoutTreeSplitVerticalAction,
} from "@/layout/lib/types";
import { fireAndForget } from "@/util/util";
import {
    PanelAxis,
    PanelSibling,
    panelSizeKind,
    PanelSizes,
    PanelSizesMetaKey,
    readPanelSizes,
    rememberedPanelPx,
    rememberPanelSize,
    sizesForRememberedPanel,
} from "./panel-size-model";

// A second drag recorded before the first write came back builds on the first, not on the stale meta.
let unconfirmed: PanelSizes = null;

function currentPanelSizes(): PanelSizes {
    if (unconfirmed != null) {
        return unconfirmed;
    }
    const clientAtom = ClientModel.getInstance().clientAtom;
    const client = clientAtom == null ? null : globalStore.get(clientAtom);
    return readPanelSizes(client?.meta?.[PanelSizesMetaKey]);
}

function writePanelSizes(sizes: PanelSizes): void {
    const clientId = ClientModel.getInstance().clientId;
    if (clientId == null) {
        return;
    }
    unconfirmed = sizes;
    fireAndForget(async () => {
        try {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("client", clientId),
                meta: { [PanelSizesMetaKey]: sizes } as MetaType,
            });
        } finally {
            if (unconfirmed === sizes) {
                unconfirmed = null;
            }
        }
    });
}

function cachedBlockView(blockId: string): string {
    if (!blockId) {
        return null;
    }
    return WOS.getObjectValue<Block>(WOS.makeORef("block", blockId))?.meta?.view ?? null;
}

// A block created a moment ago may reach the layout before the store has loaded it.
async function loadBlockView(blockId: string): Promise<string> {
    const cached = cachedBlockView(blockId);
    if (cached != null) {
        return cached;
    }
    const block = await WOS.reloadWaveObject<Block>(WOS.makeORef("block", blockId));
    return block?.meta?.view ?? null;
}

function nodeKind(node: LayoutNode): string {
    if (node == null || node.children?.length) {
        return null;
    }
    return panelSizeKind(cachedBlockView(node.data?.blockId));
}

function parentAxis(parent: LayoutNode): PanelAxis {
    return parent.flexDirection === FlexDirection.Row ? "width" : "height";
}

// Called when a splitter drag ends, with the sizes it set and the parent's size units per pixel.
export function recordDraggedPanelSizes(model: LayoutModel, action: LayoutTreeResizeNodeAction, ratio: number): void {
    const rootNode = model.treeState?.rootNode;
    if (rootNode == null || !(ratio > 0) || !action?.resizeOperations?.length) {
        return;
    }
    let sizes = currentPanelSizes();
    let changed = false;
    for (const op of action.resizeOperations) {
        const kind = nodeKind(findNode(rootNode, op.nodeId));
        const parent = kind == null ? null : findParent(rootNode, op.nodeId);
        if (parent == null) {
            continue;
        }
        sizes = rememberPanelSize(sizes, kind, parentAxis(parent), op.size / ratio);
        changed = true;
    }
    if (changed) {
        writePanelSizes(sizes);
    }
}

async function applyRememberedPanelSize(model: LayoutModel, blockId: string): Promise<void> {
    const kind = panelSizeKind(await loadBlockView(blockId));
    if (kind == null) {
        return;
    }
    const rootNode = model.treeState?.rootNode;
    const node = model.getNodeByBlockId(blockId);
    const parent = node == null || rootNode == null ? null : findParent(rootNode, node.id);
    if (parent == null || (parent.children?.length ?? 0) < 2) {
        return;
    }
    const targetPx = rememberedPanelPx(currentPanelSizes(), kind, parentAxis(parent));
    const ratio = model.getter(model.additionalProps)?.[parent.id]?.pixelToSizeRatio;
    if (targetPx == null || !(ratio > 0)) {
        return;
    }
    const siblings: PanelSibling[] = parent.children.map((child) => ({
        size: child.size,
        fill: child.id !== node.id && nodeKind(child) == null,
    }));
    const index = parent.children.findIndex((child) => child.id === node.id);
    const next = sizesForRememberedPanel(siblings, index, targetPx, ratio);
    if (next == null) {
        return;
    }
    const resize: LayoutTreeResizeNodeAction = {
        type: LayoutTreeActionType.ResizeNode,
        resizeOperations: parent.children.map((child, i) => ({ nodeId: child.id, size: next[i] })),
    };
    model.treeReducer(resize);
}

// Called by the layout once the nodes of newly added blocks have a place and a pixel size.
export function applyRememberedPanelSizes(model: LayoutModel, blockIds: string[]): void {
    for (const blockId of blockIds) {
        fireAndForget(() => applyRememberedPanelSize(model, blockId));
    }
}

// The block a layout action adds, for the actions that add one.
export function addedBlockId(action: LayoutTreeAction): string {
    switch (action?.type) {
        case LayoutTreeActionType.InsertNode:
        case LayoutTreeActionType.InsertNodeAtIndex:
            return (
                (action as LayoutTreeInsertNodeAction | LayoutTreeInsertNodeAtIndexAction).node?.data?.blockId ?? null
            );
        case LayoutTreeActionType.SplitHorizontal:
        case LayoutTreeActionType.SplitVertical:
            return (
                (action as LayoutTreeSplitHorizontalAction | LayoutTreeSplitVerticalAction).newNode?.data?.blockId ??
                null
            );
        default:
            return null;
    }
}
