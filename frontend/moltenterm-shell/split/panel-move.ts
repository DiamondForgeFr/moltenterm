// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A view is columns of panels (FR-SHELL-086), wired to the layout: a panel dragged by its header lands on one of the
// four zones of the panel under the pointer; a tab or a file dropped on a panel lands the same way. Left or right
// makes a new top-level column, above or below stacks the panel in the column (panel-move-model.ts).

import { getLayoutModelForStaticTab, LayoutTreeActionType, newLayoutNode } from "@/layout/index";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { findNode } from "@/layout/lib/layoutNode";
import type {
    LayoutNode,
    LayoutTreeDeleteNodeAction,
    LayoutTreeResizeNodeAction,
    LayoutTreeSplitHorizontalAction,
    LayoutTreeSplitVerticalAction,
} from "@/layout/lib/types";
import { t } from "../i18n/i18n";
import type { DropTarget } from "./drop-model";
import { hitTestPanels } from "./drop-zones";
import { columnIndexOfNode, effectiveSide, nearestSide, PanelPlace, panelPlace, placeSizes } from "./panel-move-model";
import { insertBlockBeside } from "./split";
import type { SplitDirection } from "./split-model";

export type PanelMoveTarget = { target: DropTarget; nodeId: string; side: SplitDirection; label: string };

// The name the target panel shows in its header (an agent's first name, a view's title), for the zone's chip.
export function panelName(blockId: string): string {
    const elem = document.querySelector(`.block[data-blockid="${CSS.escape(blockId)}"]`);
    const title =
        elem?.querySelector(".molten-header-title")?.textContent?.trim() ||
        elem?.querySelector(".molten-browser-tab.active .molten-browser-tab-name")?.textContent?.trim();
    return title || t("split.zone.panel");
}

export function zoneLabel(side: SplitDirection, name: string): string {
    return side == null ? "" : t(`split.zone.${side}`, { name });
}

function in360(layoutModel: LayoutModel): boolean {
    return !!layoutModel?.moltenView360?.active;
}

// The side a drop on a panel lands on, once the 360 view's rule applies (nothing before the fixed zone).
export function landingSide(layoutModel: LayoutModel, nodeId: string, side: SplitDirection): SplitDirection {
    const root = layoutModel?.treeState?.rootNode;
    if (side == null || root == null) {
        return side;
    }
    return effectiveSide(side, columnIndexOfNode(root, nodeId), in360(layoutModel));
}

// The panel under the pointer and the zone a dragged panel would land on; null over the dragged panel itself or away
// from the panels.
export function panelMoveTargetAt(movedBlockId: string, x: number, y: number): PanelMoveTarget {
    const layoutModel = getLayoutModelForStaticTab();
    const target = hitTestPanels(x, y);
    if (layoutModel == null || target == null || target.blockId === movedBlockId) {
        return null;
    }
    const node = layoutModel.getNodeByBlockId(target.blockId);
    if (node == null) {
        return null;
    }
    const side = landingSide(layoutModel, node.id, nearestSide(x, y, target.rect));
    if (side == null) {
        return null;
    }
    return { target, nodeId: node.id, side, label: zoneLabel(side, panelName(target.blockId)) };
}

function placeNode(layoutModel: LayoutModel, place: PanelPlace, node: LayoutNode): boolean {
    const root = layoutModel.treeState?.rootNode;
    const targetNodeId = place.kind === "column" ? place.columnId : place.targetNodeId;
    if (root == null || findNode(root, targetNodeId) == null) {
        return false;
    }
    const sizes = placeSizes(place, root);
    node.size = sizes.added;
    const split = {
        type: place.kind === "column" ? LayoutTreeActionType.SplitHorizontal : LayoutTreeActionType.SplitVertical,
        targetNodeId,
        newNode: node,
        position: place.position,
        focused: true,
    } as LayoutTreeSplitHorizontalAction | LayoutTreeSplitVerticalAction;
    if (sizes.target == null) {
        layoutModel.treeReducer(split);
        return true;
    }
    // Both actions before the layout is drawn: no frame with the target squeezed by a default size.
    layoutModel.treeReducer(split, false);
    layoutModel.treeReducer({
        type: LayoutTreeActionType.ResizeNode,
        resizeOperations: [{ nodeId: targetNodeId, size: sizes.target }],
    } as LayoutTreeResizeNodeAction);
    return true;
}

// Moves a panel of the layout to a zone of another one. The panel leaves its place and is laid at the new one in the
// same pass, so no frame (and no orphan cleanup) ever sees it out of the tree.
export function movePanel(layoutModel: LayoutModel, movedNodeId: string, targetNodeId: string, side: SplitDirection) {
    const root = layoutModel?.treeState?.rootNode;
    const place = panelPlace(root, targetNodeId, side, movedNodeId);
    const moved = place == null ? null : findNode(root, movedNodeId);
    if (moved == null) {
        return false;
    }
    layoutModel.treeReducer(
        { type: LayoutTreeActionType.DeleteNode, nodeId: movedNodeId } as LayoutTreeDeleteNodeAction,
        false
    );
    return placeNode(layoutModel, place, moved);
}

// The drop of a panel dragged by its header (TileLayout.tsx).
export function dropPanelAt(layoutModel: LayoutModel, movedNode: LayoutNode, x: number, y: number): boolean {
    const movedBlockId = movedNode?.data?.blockId;
    if (layoutModel == null || !movedBlockId || x == null || y == null) {
        return false;
    }
    const at = panelMoveTargetAt(movedBlockId, x, y);
    if (at == null) {
        return false;
    }
    return movePanel(layoutModel, movedNode.id, at.nodeId, at.side);
}

// Lays an existing block out on a zone of a panel of the shown tab (a tab or a file dropped on it): left or right as a
// new column beside the panel's column, above or below stacked in it. Returns false when the panel is not in the
// layout.
export function insertBlockAtZone(targetBlockId: string, side: SplitDirection, newBlockId: string): boolean {
    if (side === "up" || side === "down") {
        return insertBlockBeside(targetBlockId, side, newBlockId);
    }
    const layoutModel = getLayoutModelForStaticTab();
    const target = layoutModel?.getNodeByBlockId(targetBlockId);
    if (target == null || !newBlockId) {
        return false;
    }
    if (layoutModel.magnifiedNodeId != null) {
        layoutModel.magnifyNodeToggle(layoutModel.magnifiedNodeId, false);
    }
    const place = panelPlace(layoutModel.treeState?.rootNode, target.id, landingSide(layoutModel, target.id, side));
    if (place == null) {
        return false;
    }
    return placeNode(layoutModel, place, newLayoutNode(undefined, undefined, undefined, { blockId: newBlockId }));
}
