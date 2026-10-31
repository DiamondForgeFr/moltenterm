// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Add a panel on the left / on the right" (#732), in every panel's menus next to "Split…": a new top-level column
// beside the panel's column, opening on the picker like a split (FR-SHELL-042). The panels already there keep their
// size when the new column fits beside them. When it does not, the column follows the tab's 360 decision like any
// other panel added (#1668, FR-SHELL-066): the automatic switch (and its first-switch notice) lays it on the carpet,
// and under Keep the grid the other columns give width down to their minimums instead.

import { getLayoutModelForStaticTab } from "@/layout/index";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { fireAndForget } from "@/util/util";
import { t } from "../i18n/i18n";
import { currentFirstColumnFloorPx } from "../panel-size/panel-size-store";
import { DefaultCarpetColumnPx } from "../view360/carpet-model";
import { normalColumnPxs } from "../view360/view360-decision";
import {
    besideColumns,
    besideFit,
    besidePlace,
    BesideSide,
    columnIndexOf,
    type ColumnPlace,
    insertIndexFor,
    shrinkableColumns,
} from "./add-beside-model";
import { addPickerColumn } from "./split";

export const AddBesideLeftIcon = "arrow-left";
export const AddBesideRightIcon = "arrow-right";

function tabWidthPx(layoutModel: LayoutModel): { width: number; gap: number } {
    const view360 = layoutModel.moltenView360;
    let width = view360?.lastEvalWidth ?? 0;
    if (!(width > 0)) {
        width = layoutModel.displayContainerRef?.current?.getBoundingClientRect()?.width ?? 0;
    }
    return { width, gap: view360?.lastEvalGap ?? 0 };
}

// Where the column goes, read from the layout as it is now, with the columns' sizes when it stays in the normal
// layout. Null when the entry is not offered: no layout, a magnified panel, nothing before the fixed zone.
function planBeside(layoutModel: LayoutModel, blockId: string, side: BesideSide): ColumnPlace {
    const rootNode = layoutModel?.treeState?.rootNode;
    const node = blockId ? layoutModel?.getNodeByBlockId(blockId) : null;
    if (rootNode == null || node == null || layoutModel.magnifiedNodeId != null) {
        return null;
    }
    const view360 = layoutModel.moltenView360;
    const columnIndex = columnIndexOf(rootNode, node.id);
    if (view360?.layout != null || view360?.wanted) {
        // A single column wanting 360 view is the fixed zone to be: nothing goes before it.
        if (view360.layout == null && side === "left" && columnIndex === 0) {
            return null;
        }
        return besidePlace(rootNode, node.id, side, view360.layout);
    }
    const place = besidePlace(rootNode, node.id, side, null);
    if (place == null || columnIndex < 0) {
        return null;
    }
    const { width, gap } = tabWidthPx(layoutModel);
    const columns = besideColumns(rootNode);
    const pxs = normalColumnPxs(
        columns.map((c) => c.size),
        width,
        gap
    );
    // The floor belongs to whatever ends up first (#848): the first column, or the new one when it goes before it.
    const floor = currentFirstColumnFloorPx() ?? 0;
    const insertIndex = insertIndexFor(columnIndex, side);
    const kept = columns.map((column, i) => ({
        px: pxs[i],
        needPx: i === 0 && insertIndex > 0 ? floor : 0,
        carpetPx: view360?.columnWidthPx(column) ?? DefaultCarpetColumnPx,
    }));
    const firstAsk = insertIndex === 0 ? floor : 0;
    const sizes = besideFit(kept, insertIndex, Math.max(DefaultCarpetColumnPx, firstAsk), width, gap);
    if (sizes != null) {
        return { ...place, columnSizes: sizes };
    }
    if (view360?.wantsWithColumns(columns.length + 1, width, gap)) {
        // The automatic switch takes the column to the carpet; in 360 view nothing goes before the fixed zone, which
        // the first column becomes.
        return side === "left" && columnIndex === 0 ? null : place;
    }
    // The tab stays in the grid: the columns give width down to their minimums, the new one an equal share when the
    // room allows it.
    const shared = besideFit(shrinkableColumns(kept), insertIndex, firstAsk, width, gap);
    return shared == null ? place : { ...place, columnSizes: shared };
}

// The sides offered for the panel's menus.
export function besideSides(blockId: string): BesideSide[] {
    const layoutModel = getLayoutModelForStaticTab();
    return (["left", "right"] as BesideSide[]).filter((side) => planBeside(layoutModel, blockId, side) != null);
}

export async function addPanelBeside(blockId: string, side: BesideSide): Promise<string> {
    const layoutModel = getLayoutModelForStaticTab();
    if (planBeside(layoutModel, blockId, side) == null) {
        return null;
    }
    // Read again once the block exists: the layout may have changed meanwhile.
    return addPickerColumn(layoutModel, blockId, () => planBeside(layoutModel, blockId, side));
}

export function besideLabel(side: BesideSide): string {
    return side === "left" ? t("split.beside.left") : t("split.beside.right");
}

export function besideIcon(side: BesideSide): string {
    return side === "left" ? AddBesideLeftIcon : AddBesideRightIcon;
}

export function besideMenuItems(blockId: string, section: string): ContextMenuItem[] {
    return besideSides(blockId).map((side) => ({
        label: besideLabel(side),
        icon: besideIcon(side),
        section,
        click: () => fireAndForget(() => addPanelBeside(blockId, side)),
    }));
}
