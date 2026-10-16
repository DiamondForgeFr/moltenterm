// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Add a panel on the left / on the right" (#732), in every panel's menus next to "Split…": a new top-level column
// beside the panel's column, opening on the picker like a split (FR-SHELL-042). The panels already there keep their
// size: when the new column does not fit beside them, the tab turns its 360 view on and the column is laid on the
// carpet at its place, scrolled into view and focused.

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { fireAndForget } from "@/util/util";
import { t } from "../i18n/i18n";
import { currentFirstColumnFloorPx } from "../panel-size/panel-size-store";
import { clampFixedPx, DefaultCarpetColumnPx } from "../view360/carpet-model";
import { normalColumnPxs } from "../view360/view360-decision";
import { View360FixedPxMetaKey, View360MetaKey } from "../view360/view360-meta";
import {
    besideColumns,
    besideFit,
    besidePlace,
    BesideSide,
    columnIndexOf,
    type ColumnPlace,
    insertIndexFor,
} from "./add-beside-model";
import { addPickerColumn } from "./split";

export const AddBesideLeftIcon = "arrow-left";
export const AddBesideRightIcon = "arrow-right";
// The tab's 360 view state can take a round trip to arrive; past this the column is added anyway.
const View360WaitMs = 10000;

type BesidePlan = { place: ColumnPlace; needs360: boolean; firstPx: number };

function tabWidthPx(layoutModel: LayoutModel): { width: number; gap: number } {
    const view360 = layoutModel.moltenView360;
    let width = view360?.lastEvalWidth ?? 0;
    if (!(width > 0)) {
        width = layoutModel.displayContainerRef?.current?.getBoundingClientRect()?.width ?? 0;
    }
    return { width, gap: view360?.lastEvalGap ?? 0 };
}

// Where the column goes and whether the tab must go to 360 view for it, read from the layout as it is now. Null when
// the entry is not offered: no layout, a magnified panel, nothing before the fixed zone.
function planBeside(layoutModel: LayoutModel, blockId: string, side: BesideSide): BesidePlan {
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
        const place = besidePlace(rootNode, node.id, side, view360.layout);
        return place == null ? null : { place, needs360: false, firstPx: null };
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
    const sizes = besideFit(
        columns.map((column, i) => ({
            px: pxs[i],
            needPx: i === 0 && insertIndex > 0 ? floor : 0,
            carpetPx: view360?.columnWidthPx(column) ?? DefaultCarpetColumnPx,
        })),
        insertIndex,
        insertIndex === 0 ? Math.max(DefaultCarpetColumnPx, floor) : DefaultCarpetColumnPx,
        width,
        gap
    );
    if (sizes != null) {
        return { place: { ...place, columnSizes: sizes }, needs360: false, firstPx: null };
    }
    // In 360 view nothing goes before the fixed zone, which the first column becomes.
    if (side === "left" && columnIndex === 0) {
        return null;
    }
    return { place, needs360: true, firstPx: clampFixedPx(pxs[0], width, floor) };
}

// The sides offered for the panel's menus.
export function besideSides(blockId: string): BesideSide[] {
    const layoutModel = getLayoutModelForStaticTab();
    return (["left", "right"] as BesideSide[]).filter((side) => planBeside(layoutModel, blockId, side) != null);
}

function waitForWanted(layoutModel: LayoutModel): Promise<void> {
    const view360 = layoutModel.moltenView360;
    if (view360 == null || view360.wanted) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        let unsub: () => void = null;
        const done = () => {
            clearTimeout(timer);
            unsub?.();
            resolve();
        };
        const timer = setTimeout(done, View360WaitMs);
        unsub = globalStore.sub(view360.decisionAtom, () => {
            if (view360.wanted) {
                done();
            }
        });
    });
}

// Turns the tab's 360 view on on demand (#733), the fixed zone at the first column's current width so it keeps its
// size, in one meta write.
async function enter360KeepingFirst(layoutModel: LayoutModel, firstPx: number): Promise<void> {
    const view360 = layoutModel.moltenView360;
    const tabId = view360?.tabId;
    if (tabId == null) {
        return;
    }
    const meta: Record<string, unknown> = { [View360MetaKey]: true };
    if (firstPx > 0) {
        meta[View360FixedPxMetaKey] = Math.round(firstPx);
    }
    await RpcApi.SetMetaCommand(TabRpcClient, { oref: WOS.makeORef("tab", tabId), meta: meta as MetaType });
    await waitForWanted(layoutModel);
}

export async function addPanelBeside(blockId: string, side: BesideSide): Promise<string> {
    const layoutModel = getLayoutModelForStaticTab();
    const plan = planBeside(layoutModel, blockId, side);
    if (plan == null) {
        return null;
    }
    if (plan.needs360) {
        await enter360KeepingFirst(layoutModel, plan.firstPx);
    }
    // Read again once the block exists: the layout may have changed meanwhile.
    const place = () =>
        plan.needs360 ? replan360(layoutModel, blockId, side) : planBeside(layoutModel, blockId, side)?.place;
    return addPickerColumn(layoutModel, blockId, place);
}

// Once the tab wants 360 view: the place beside the panel (the carpet takes it from there, rewriteAction).
function replan360(layoutModel: LayoutModel, blockId: string, side: BesideSide): ColumnPlace {
    const rootNode = layoutModel?.treeState?.rootNode;
    const node = blockId ? layoutModel?.getNodeByBlockId(blockId) : null;
    if (rootNode == null || node == null) {
        return null;
    }
    return besidePlace(rootNode, node.id, side, layoutModel.moltenView360?.layout ?? null);
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
