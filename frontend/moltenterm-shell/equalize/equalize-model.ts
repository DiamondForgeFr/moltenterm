// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Equalize panels (#825), one per tab layout: a click evens out the panel columns once; the auto mode, kept in the
// tab's meta, evens them out again after every change of the tree's shape (a panel added, closed or moved) and every
// 360 layout pass. A divider dragged by hand turns the auto mode off and says so: the developer's size wins.

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { balanceNode, findNode } from "@/layout/lib/layoutNode";
import { LayoutTreeActionType, type LayoutNode, type LayoutTreeResizeNodeAction } from "@/layout/lib/types";
import { fireAndForget } from "@/util/util";
import { Atom, atom, PrimitiveAtom } from "jotai";
import { selectAtom } from "jotai/utils";
import { t } from "../i18n/i18n";
import { rememberedPanelPx } from "../panel-size/panel-size-model";
import { cachedBlockView, currentPanelSizes, rememberPanelWidth } from "../panel-size/panel-size-store";
import { showToast } from "../toast-store";
import { carpetColumnKind, columnLeadLeaf } from "../view360/carpet-model";
import { equalCarpetWidthPx, equalizeOps, hasColumnsToEqualize, type EqualizeOptions } from "./equalize-rules";

export const EqualizeAutoMetaKey = "molten:equalizeauto";
const AutoOffToastId = "equalize-auto-off";

export function tabEqualizeAuto(tab: Tab): boolean {
    return (tab?.meta as Record<string, unknown>)?.[EqualizeAutoMetaKey] === true;
}

function setTabEqualizeAuto(tabId: string, on: boolean): Promise<void> {
    return RpcApi.SetMetaCommand(TabRpcClient, {
        oref: WOS.makeORef("tab", tabId),
        meta: { [EqualizeAutoMetaKey]: on ? true : null } as MetaType,
    });
}

// The tree's shape (ids and directions, not sizes): the auto mode acts when it changes.
export function treeShape(node: LayoutNode): string {
    if (node == null) {
        return "";
    }
    if (!node.children?.length) {
        return node.id;
    }
    return `${node.id}:${node.flexDirection}(${node.children.map(treeShape).join(",")})`;
}

export class EqualizeModel {
    layoutModel: LayoutModel;
    tabAtom: Atom<Tab>;

    // This window's last write, ahead of the meta's round trip (null: the meta is the truth).
    pendingAutoAtom: PrimitiveAtom<boolean> = atom(null) as PrimitiveAtom<boolean>;
    autoAtom: Atom<boolean>;
    // Whether the tab has two panels side by side (the button is disabled otherwise).
    canEqualizeAtom: Atom<boolean>;

    lastShape: string = null;
    carpetTimer: ReturnType<typeof setTimeout> = null;

    constructor(layoutModel: LayoutModel, tabAtom: Atom<Tab>) {
        this.layoutModel = layoutModel;
        this.tabAtom = tabAtom;
        const metaAutoAtom = selectAtom(tabAtom, (tab) => tabEqualizeAuto(tab));
        this.autoAtom = atom((get) => get(this.pendingAutoAtom) ?? get(metaAutoAtom));
        globalStore.sub(metaAutoAtom, () => globalStore.set(this.pendingAutoAtom, null));
        // The leaf order is set on every layout pass: it stands for the tree, read as it is then.
        this.canEqualizeAtom = atom((get) => {
            get(layoutModel.leafOrder);
            return hasColumnsToEqualize(layoutModel.treeState?.rootNode);
        });
        const view360 = layoutModel.moltenView360;
        if (view360 != null) {
            globalStore.sub(view360.layoutAtom, () => this.scheduleCarpet());
        }
    }

    get auto(): boolean {
        return globalStore.get(this.autoAtom);
    }

    get tabId(): string {
        return globalStore.get(this.tabAtom)?.oid ?? null;
    }

    setAuto(on: boolean): void {
        if (on === this.auto) {
            return;
        }
        globalStore.set(this.pendingAutoAtom, on);
        const tabId = this.tabId;
        if (tabId != null) {
            fireAndForget(() => setTabEqualizeAuto(tabId, on));
        }
        if (on) {
            this.equalize();
        }
    }

    toggleAuto(): void {
        this.setAuto(!this.auto);
    }

    // In 360 view the root's columns are drawn by the carpet layout: the fixed zone is left as it is and only the
    // carpet's columns are evened out, inside (the tree) and against each other (their widths).
    private options(): EqualizeOptions {
        const layout = this.layoutModel.moltenView360?.layout;
        if (layout == null) {
            return {};
        }
        return { keepRootChildren: true, skipNodeIds: layout.fixedColumns.map((c) => c.nodeId) };
    }

    // Evens out the tab's panel columns once.
    equalize(): void {
        const rootNode = this.layoutModel.treeState?.rootNode;
        if (rootNode == null) {
            return;
        }
        const ops = equalizeOps(rootNode, this.options());
        this.lastShape = treeShape(rootNode);
        if (ops.length) {
            const resize: LayoutTreeResizeNodeAction = {
                type: LayoutTreeActionType.ResizeNode,
                resizeOperations: ops,
            };
            this.layoutModel.treeReducer(resize);
        }
        if (this.equalizeCarpet()) {
            this.layoutModel.updateTree(false);
        }
    }

    // Called by the layout before it redraws after an action: with the auto mode on, a new shape is evened out in
    // place, before the first frame shows it.
    beforeUpdate(): void {
        if (!this.auto) {
            return;
        }
        const treeState = this.layoutModel.treeState;
        if (treeState?.rootNode == null) {
            return;
        }
        treeState.rootNode = balanceNode(treeState.rootNode);
        const shape = treeShape(treeState.rootNode);
        if (shape === this.lastShape) {
            return;
        }
        this.lastShape = shape;
        for (const op of equalizeOps(treeState.rootNode, this.options())) {
            const node = findNode(treeState.rootNode, op.nodeId);
            if (node != null) {
                node.size = op.size;
            }
        }
    }

    // Called by the layout when a divider is released: a drag by hand turns the auto mode off, with a one-line notice.
    onResizeEnd(draggedTree: boolean): void {
        const view360 = this.layoutModel.moltenView360;
        const dragged360 =
            view360 != null && (view360.dragFixedPx != null || view360.dragColumn != null || view360.dragPin != null);
        if (!(draggedTree || dragged360) || !this.auto) {
            return;
        }
        this.setAuto(false);
        showToast({ id: AutoOffToastId, kind: "info", title: t("equalize.autoOffNotice") });
    }

    // The carpet columns' widths, evened out against each other; true when a width changed.
    private equalizeCarpet(): boolean {
        const view360 = this.layoutModel.moltenView360;
        const layout = view360?.layout;
        const rootNode = this.layoutModel.treeState?.rootNode;
        if (layout == null || rootNode == null) {
            return false;
        }
        const px = equalCarpetWidthPx(layout.columns.map((c) => c.width));
        if (px == null) {
            return false;
        }
        const kinds = new Set<string>();
        for (const column of layout.columns) {
            const node = findNode(rootNode, column.nodeId);
            const kind = node == null ? null : carpetColumnKind(cachedBlockView(columnLeadLeaf(node)?.data?.blockId));
            if (kind) {
                kinds.add(kind);
            }
        }
        const stale = [...kinds].filter((kind) => rememberedPanelPx(currentPanelSizes(), kind, "width") !== px);
        if (stale.length === 0) {
            return false;
        }
        stale.forEach((kind) => rememberPanelWidth(kind, px));
        return true;
    }

    // Each 360 layout pass (a panel laid on the carpet, the window resized): the auto mode evens the carpet out again,
    // after the pass, never while a carpet column is being dragged.
    private scheduleCarpet() {
        if (!this.auto || this.carpetTimer != null) {
            return;
        }
        this.carpetTimer = setTimeout(() => {
            this.carpetTimer = null;
            const view360 = this.layoutModel.moltenView360;
            if (!this.auto || view360?.dragColumn != null) {
                return;
            }
            if (this.equalizeCarpet()) {
                this.layoutModel.updateTree(false);
            }
        }, 0);
    }
}
