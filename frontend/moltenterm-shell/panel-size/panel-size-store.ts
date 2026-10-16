// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Panel size memory (#606), wired to the layout: a dragged splitter records the size of the side panels it moved, in
// the client's meta like the companion's choices (the same for every tab and window, kept across restarts); a side
// panel added to a layout takes the size remembered for its kind. The first column's divider also sets its floor
// (#848), which a panel added beside it never squeezes.

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
import { columnsParent, SideColumnMinPx } from "../view360/view360-decision";
import {
    FirstColumnFloorMetaKey,
    floorFromFirstColumnDrag,
    LegacyTerminalFloorMetaKey,
    needsFloorMigration,
    PanelAxis,
    PanelSibling,
    panelSizeKind,
    PanelSizes,
    PanelSizesMetaKey,
    readFirstColumnFloor,
    readPanelSizes,
    rememberedPanelPx,
    rememberPanelSize,
    sizesForRememberedPanel,
    storedFirstColumnFloor,
} from "./panel-size-model";

// A second drag recorded before the first write came back builds on the first, not on the stale meta.
let unconfirmed: PanelSizes = null;

export function currentPanelSizes(): PanelSizes {
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

// The floor this window last wrote, ahead of the meta's round trip; { px: null } while a clear is on its way.
let unconfirmedFloor: { px: number } = null;

function clientMeta(): Record<string, unknown> {
    const clientAtom = ClientModel.getInstance().clientAtom;
    const client = clientAtom == null ? null : globalStore.get(clientAtom);
    return client?.meta as Record<string, unknown>;
}

// The first column's floor (#731, #848) in pixels, or null when none is set. A terminal floor stored before #848 is
// moved to the first column's key the first time it is read.
export function currentFirstColumnFloorPx(): number {
    if (unconfirmedFloor != null) {
        return unconfirmedFloor.px;
    }
    const meta = clientMeta();
    const floor = storedFirstColumnFloor(meta);
    if (needsFloorMigration(meta)) {
        writeFirstColumnFloor(floor);
    }
    return floor;
}

// Every write clears the terminal key too, so a migrated or cleared floor never comes back from it.
function writeFirstColumnFloor(px: number): void {
    const clientId = ClientModel.getInstance().clientId;
    if (clientId == null) {
        return;
    }
    const pending = { px };
    unconfirmedFloor = pending;
    fireAndForget(async () => {
        try {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("client", clientId),
                meta: { [FirstColumnFloorMetaKey]: px, [LegacyTerminalFloorMetaKey]: null } as MetaType,
            });
        } finally {
            if (unconfirmedFloor === pending) {
                unconfirmedFloor = null;
            }
        }
    });
}

export function setFirstColumnFloor(px: number): void {
    const floor = readFirstColumnFloor(px);
    if (floor == null || floor === currentFirstColumnFloorPx()) {
        return;
    }
    writeFirstColumnFloor(floor);
}

// Back to "no floor": the first column shares the room again down to its readable minimum ("Readjust every size",
// #733).
export function clearFirstColumnFloor(): void {
    if (currentFirstColumnFloorPx() == null) {
        return;
    }
    writeFirstColumnFloor(null);
}

// A carpet column dragged in 360 view (#614): its kind's remembered width, shared with the normal layout's memory.
export function rememberPanelWidth(kind: string, px: number): void {
    if (!kind) {
        return;
    }
    writePanelSizes(rememberPanelSize(currentPanelSizes(), kind, "width", px));
}

export function cachedBlockView(blockId: string): string {
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
        const node = findNode(rootNode, op.nodeId);
        const parent = node == null ? null : findParent(rootNode, op.nodeId);
        if (parent == null) {
            continue;
        }
        const kind = nodeKind(node);
        if (kind == null) {
            continue;
        }
        sizes = rememberPanelSize(sizes, kind, parentAxis(parent), op.size / ratio);
        changed = true;
    }
    if (changed) {
        writePanelSizes(sizes);
    }
    // The first column's divider sets its floor (#848), whatever the column holds; other dividers never do.
    const floor = floorFromFirstColumnDrag(columnsParent(rootNode)?.children[0]?.id, action.resizeOperations, ratio);
    if (floor != null) {
        setFirstColumnFloor(floor);
    }
}

// The width the added panel asks for: its kind's remembered width; without one, while the first column has a floor,
// the width the layout gave it (so the floor still holds), at least a readable column; a panel that becomes the
// first column takes the floor.
function addedPanelTargetPx(
    view: string,
    node: LayoutNode,
    ratio: number,
    floor: number,
    isFirstColumn: boolean
): number {
    const remembered = rememberedPanelPx(currentPanelSizes(), panelSizeKind(view), "width");
    if (floor == null) {
        return remembered;
    }
    const px = remembered ?? node.size / ratio;
    // The layout's split can leave the new column a sliver once the first column keeps its floor.
    return Math.max(px, isFirstColumn ? floor : SideColumnMinPx);
}

async function applyRememberedPanelSize(model: LayoutModel, blockId: string): Promise<void> {
    const view = await loadBlockView(blockId);
    const kind = panelSizeKind(view);
    const rootNode = model.treeState?.rootNode;
    const node = model.getNodeByBlockId(blockId);
    const parent = node == null || rootNode == null ? null : findParent(rootNode, node.id);
    if (parent == null || (parent.children?.length ?? 0) < 2) {
        return;
    }
    const axis = parentAxis(parent);
    // The floor counts only among the top-level columns: the panel added beside or before the first column.
    const columns = columnsParent(rootNode);
    const floor = columns?.id === parent.id ? currentFirstColumnFloorPx() : null;
    if (kind == null && floor == null) {
        return;
    }
    const ratio = model.getter(model.additionalProps)?.[parent.id]?.pixelToSizeRatio;
    if (!(ratio > 0)) {
        return;
    }
    const firstId = parent.children[0].id;
    const targetPx =
        floor == null
            ? rememberedPanelPx(currentPanelSizes(), kind, axis)
            : addedPanelTargetPx(view, node, ratio, floor, firstId === node.id);
    if (targetPx == null) {
        return;
    }
    const siblings: PanelSibling[] = parent.children.map((child) => {
        const fill = child.id !== node.id && nodeKind(child) == null;
        return floor != null && child.id === firstId && child.id !== node.id
            ? { size: child.size, fill, minPx: floor }
            : { size: child.size, fill };
    });
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
