// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// 360 view of a workspace tab (FR-SHELL-065), wired to its layout. One model per LayoutModel: the layout asks it where
// the root's columns are drawn, and it owns the carpet's scroll position. The API the next 360 view stories build on:
// activeAtom / setActive (#615's setting and tab-bar toggle), layoutAtom and fixed-zone membership (#616's pinning),
// scrollLeftAtom, visibleColumnIdsAtom and scrollToColumn (#617's scrubber, #618's off-screen throttling).

import { getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { findNode } from "@/layout/lib/layoutNode";
import {
    FlexDirection,
    LayoutNode,
    LayoutTreeAction,
    LayoutTreeActionType,
    LayoutTreeInsertNodeAction,
    LayoutTreeInsertNodeAtIndexAction,
    LayoutTreeResizeNodeAction,
    LayoutTreeSplitHorizontalAction,
    ResizeHandleProps,
} from "@/layout/lib/types";
import { setTransform } from "@/layout/lib/utils";
import { fireAndForget } from "@/util/util";
import { Atom, atom, PrimitiveAtom } from "jotai";
import { selectAtom } from "jotai/utils";
import type { CSSProperties } from "react";
import { rememberedPanelPx } from "../panel-size/panel-size-model";
import { cachedBlockView, currentPanelSizes, rememberPanelWidth } from "../panel-size/panel-size-store";
import {
    CarpetColumnGapPx,
    carpetColumnKind,
    carpetColumnRect,
    CarpetLayout,
    CarpetMarginPx,
    carpetNodeTransform,
    CarpetScrollVar,
    clampColumnPx,
    clampFixedPx,
    clampScroll,
    columnLeadLeaf,
    computeCarpetLayout,
    defaultCarpetWidthPx,
    Rect,
    scrollToRevealColumn,
    splitCarpetColumns,
    visibleCarpetColumnIds,
} from "./carpet-model";
import {
    anyColumnTooTight,
    autoWants,
    decideView360,
    normalColumnPxs,
    normalizeView360Setting,
    ResizeSettleMs,
    showTightPill,
    topColumns,
    View360Decision,
    View360SettingKey,
} from "./view360-decision";
import { setTabFixedPx, setTabView360, storedFixedPx, tabManualView360 } from "./view360-meta";

const SmoothScrollMs = 260;
// Transitions stay off this long after the last scroll step, so the panels follow the scroll without lag.
const ScrollSettleMs = 140;

export type CarpetRootChild = { rect: Rect; carpet: boolean };

function sameIds(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((id, i) => id === b[i]);
}

export class View360Model {
    layoutModel: LayoutModel;
    tabAtom: Atom<Tab>;

    // The mode (FR-SHELL-066): the setting, the tab's manual choice, and what the layout last measured.
    settingAtom: Atom<string>;
    manualAtom: Atom<boolean>;
    autoOnAtom: PrimitiveAtom<boolean> = atom(false);
    columnCountAtom: PrimitiveAtom<number> = atom(0);
    tooTightAtom: PrimitiveAtom<boolean> = atom(false);
    // The column count when the "too tight" pill was closed; null while it is not dismissed.
    pillDismissedAtAtom: PrimitiveAtom<number> = atom(null) as PrimitiveAtom<number>;
    // Bumped on each automatic switch, for its short glow.
    signalAtom: PrimitiveAtom<number> = atom(0);
    decisionAtom: Atom<View360Decision>;
    activeAtom: Atom<boolean>;
    pillAtom: Atom<boolean>;
    // The geometry of the last layout pass, null when the tab is not drawn in 360 view.
    layoutAtom: PrimitiveAtom<CarpetLayout> = atom(null) as PrimitiveAtom<CarpetLayout>;
    scrollLeftAtom: PrimitiveAtom<number> = atom(0);
    visibleColumnIdsAtom: Atom<string[]>;
    fixedNodeIdAtom: Atom<string>;

    layout: CarpetLayout = null;
    scrollLeft = 0;
    // The fixed zone's width as this window last set it, ahead of the tab meta's round trip.
    savedFixedPx: number = null;
    // Widths being dragged, applied until the drag ends.
    dragFixedPx: number = null;
    dragColumn: { nodeId: string; kind: string; px: number } = null;

    scrollFrame: number = null;
    settleTimer: ReturnType<typeof setTimeout> = null;
    smoothFrame: number = null;
    rootChildren: Map<string, CarpetRootChild> = new Map();

    // The automatic decision's last inputs: a new column count switches at once, a width change once it holds.
    lastColumnCount: number = null;
    settleTimer360: ReturnType<typeof setTimeout> = null;
    applySettled = false;
    inLayoutPass = false;

    constructor(layoutModel: LayoutModel, tabAtom: Atom<Tab>) {
        this.layoutModel = layoutModel;
        this.tabAtom = tabAtom;
        this.settingAtom = getSettingsKeyAtom(View360SettingKey as keyof SettingsType) as Atom<string>;
        this.manualAtom = atom((get) => tabManualView360(get(tabAtom)));
        this.decisionAtom = atom((get) =>
            decideView360({
                setting: normalizeView360Setting(get(this.settingAtom)),
                manual: get(this.manualAtom),
                autoOn: get(this.autoOnAtom),
                columnCount: get(this.columnCountAtom),
            })
        );
        this.activeAtom = selectAtom(this.decisionAtom, (d) => d.active);
        this.pillAtom = atom((get) => {
            const count = get(this.columnCountAtom);
            const dismissedAt = get(this.pillDismissedAtAtom);
            return showTightPill({
                setting: normalizeView360Setting(get(this.settingAtom)),
                manual: get(this.manualAtom),
                active: get(this.activeAtom),
                tooTight: get(this.tooTightAtom),
                dismissed: dismissedAt != null && count <= dismissedAt,
            });
        });
        const visibleAtom = atom((get) => visibleCarpetColumnIds(get(this.layoutAtom), get(this.scrollLeftAtom)));
        this.visibleColumnIdsAtom = selectAtom(visibleAtom, (ids) => ids, sameIds);
        this.fixedNodeIdAtom = atom((get) => get(this.layoutAtom)?.fixedNodeId ?? null);
        // A switch decided inside a layout pass is already drawn by that pass.
        globalStore.sub(this.activeAtom, () => {
            if (!this.inLayoutPass) {
                this.layoutModel.updateTree();
            }
        });
        globalStore.sub(this.layoutModel.focusedNode, () => this.revealFocusedNode());
    }

    get active(): boolean {
        return globalStore.get(this.activeAtom);
    }

    // What the tab asks for whatever its columns: a panel opened in a single-column tab that wants 360 view goes to
    // the carpet.
    get wanted(): boolean {
        return globalStore.get(this.decisionAtom).wanted;
    }

    get tabId(): string {
        return globalStore.get(this.tabAtom)?.oid ?? null;
    }

    // The tab's manual choice (the tab bar's toggle, the pill's action): true or false wins over the setting, null
    // follows it again.
    setManual(choice: boolean): void {
        const tabId = this.tabId;
        if (tabId == null || choice === globalStore.get(this.manualAtom)) {
            return;
        }
        fireAndForget(() => setTabView360(tabId, choice));
    }

    setActive(on: boolean): void {
        this.setManual(on);
    }

    toggle(): void {
        this.setActive(!this.active);
    }

    dismissPill(): void {
        globalStore.set(this.pillDismissedAtAtom, globalStore.get(this.columnCountAtom));
    }

    // ---- the automatic decision ------------------------------------------------------------------------------------

    private gapPx(): number {
        const gapAtom = this.layoutModel.gapSizePx;
        return gapAtom == null ? 0 : (globalStore.get(gapAtom) ?? 0);
    }

    // Called by the layout at the start of each pass, before it asks whether the tab is in 360 view.
    evaluate(rootNode: LayoutNode, bounds: Rect): void {
        const width = bounds?.width;
        if (!(width > 0)) {
            return;
        }
        this.inLayoutPass = true;
        try {
            this.evaluateInPass(rootNode, width);
        } finally {
            this.inLayoutPass = false;
        }
    }

    private evaluateInPass(rootNode: LayoutNode, width: number) {
        const columns = topColumns(rootNode);
        const count = columns.length;
        const gap = this.gapPx();
        globalStore.set(this.columnCountAtom, count);
        const dismissedAt = globalStore.get(this.pillDismissedAtAtom);
        if (dismissedAt != null && count > dismissedAt) {
            globalStore.set(this.pillDismissedAtAtom, null);
        }
        const normalPxs = normalColumnPxs(
            columns.map((c) => c.size),
            width,
            gap
        );
        globalStore.set(this.tooTightAtom, anyColumnTooTight(normalPxs));

        const prevOn = globalStore.get(this.autoOnAtom);
        const want = autoWants(prevOn, count, width, gap);
        const first = this.lastColumnCount == null;
        const countChanged = !first && count !== this.lastColumnCount;
        this.lastColumnCount = count;
        if (want === prevOn) {
            this.cancelSettle();
            this.applySettled = false;
            return;
        }
        if (first || countChanged || this.applySettled) {
            this.cancelSettle();
            this.applySettled = false;
            this.applyAuto(want, !first);
            return;
        }
        this.scheduleSettle();
    }

    private applyAuto(on: boolean, signal: boolean) {
        const before = this.active;
        globalStore.set(this.autoOnAtom, on);
        if (signal && this.active !== before && globalStore.get(this.decisionAtom).source === "auto") {
            globalStore.set(this.signalAtom, globalStore.get(this.signalAtom) + 1);
        }
    }

    private scheduleSettle() {
        this.cancelSettle();
        this.settleTimer360 = setTimeout(() => {
            this.settleTimer360 = null;
            this.applySettled = true;
            this.layoutModel.updateTree();
        }, ResizeSettleMs);
    }

    private cancelSettle() {
        if (this.settleTimer360 != null) {
            clearTimeout(this.settleTimer360);
            this.settleTimer360 = null;
        }
    }

    // ---- layout pass ---------------------------------------------------------------------------------------------

    private storedFixedPx(): number {
        if (this.dragFixedPx != null) {
            return this.dragFixedPx;
        }
        if (this.savedFixedPx != null) {
            return this.savedFixedPx;
        }
        return storedFixedPx(globalStore.get(this.tabAtom));
    }

    private columnWidthPx(column: LayoutNode): number {
        if (this.dragColumn?.nodeId === column.id) {
            return this.dragColumn.px;
        }
        const kind = carpetColumnKind(cachedBlockView(columnLeadLeaf(column)?.data?.blockId));
        return rememberedPanelPx(currentPanelSizes(), kind, "width") ?? defaultCarpetWidthPx(kind);
    }

    // Called by the layout before it walks the tree: the geometry of the root's columns, or null for the normal layout.
    computeLayout(rootNode: LayoutNode, bounds: Rect): CarpetLayout {
        const split = this.active ? splitCarpetColumns(rootNode) : null;
        this.rootChildren = new Map();
        if (split == null || !(bounds?.width > 0)) {
            if (!this.active) {
                this.savedFixedPx = null;
            }
            this.setLayout(null);
            return null;
        }
        let fixedPx = this.storedFixedPx();
        if (fixedPx == null) {
            // Entering the view, the fixed zone keeps the first column's normal width, then holds it while panels
            // are laid on the carpet.
            const total = rootNode.children.reduce((acc, c) => acc + c.size, 0);
            fixedPx = split.carpet.length && total > 0 ? (split.fixed.size / total) * bounds.width : bounds.width;
            this.savedFixedPx = clampFixedPx(fixedPx, bounds.width);
            // Saved at once (#614 follow-up): before, the width chosen on entering was kept only once dragged.
            const tabId = this.tabId;
            const px = this.savedFixedPx;
            if (tabId != null && split.carpet.length) {
                fireAndForget(() => setTabFixedPx(tabId, px));
            }
        }
        const layout = computeCarpetLayout({
            width: bounds.width,
            height: bounds.height,
            fixedNodeId: split.fixed.id,
            fixedPx,
            columns: split.carpet.map((c) => ({ nodeId: c.id, widthPx: this.columnWidthPx(c) })),
        });
        if (split.fixed !== rootNode) {
            this.rootChildren.set(split.fixed.id, { rect: layout.fixed, carpet: false });
        }
        for (const column of layout.columns) {
            this.rootChildren.set(column.nodeId, { rect: carpetColumnRect(layout, column), carpet: true });
        }
        this.setLayout(layout);
        return layout;
    }

    private setLayout(layout: CarpetLayout) {
        this.layout = layout;
        globalStore.set(this.layoutAtom, layout);
        if (layout == null) {
            return;
        }
        const clamped = clampScroll(layout, this.scrollLeft);
        if (clamped !== this.scrollLeft) {
            this.scrollTo(clamped);
        } else {
            this.scheduleScrollWrite();
        }
    }

    // The rect of the tree's root when it is the fixed column itself (a single vertical stack).
    rootRect(rootNode: LayoutNode): Rect {
        if (this.layout == null || this.layout.fixedNodeId !== rootNode?.id) {
            return null;
        }
        return this.layout.fixed;
    }

    rootChild(nodeId: string): CarpetRootChild {
        return this.rootChildren.get(nodeId) ?? null;
    }

    carpetTransform(rect: Rect, base: CSSProperties): CSSProperties {
        if (this.layout == null) {
            return base;
        }
        return { ...base, ...carpetNodeTransform(rect, this.layout) };
    }

    gripHandleId(rootNode: LayoutNode): string {
        return `${rootNode?.id}-mtgrip`;
    }

    // The root's handles in 360 view: the fixed zone's grip, then one on the right edge of every carpet column. A
    // vertical stack alone keeps its own handles beside the grip.
    rootResizeHandles(
        rootNode: LayoutNode,
        handleSizePx: number,
        waveHandles: ResizeHandleProps[]
    ): ResizeHandleProps[] {
        const layout = this.layout;
        if (layout == null) {
            return waveHandles;
        }
        const half = handleSizePx / 2;
        const grip: Rect = {
            top: 0,
            left: layout.fixed.width + CarpetMarginPx / 2 - half,
            width: handleSizePx,
            height: layout.fixed.height,
        };
        const gripHandle: ResizeHandleProps = {
            id: this.gripHandleId(rootNode),
            parentNodeId: rootNode.id,
            parentIndex: 0,
            transform: setTransform(grip, true, false),
            flexDirection: FlexDirection.Row,
            centerPx: grip.left + half,
        };
        if (layout.fixedNodeId === rootNode.id) {
            return [...waveHandles, gripHandle];
        }
        const handles: ResizeHandleProps[] = [gripHandle];
        layout.columns.forEach((column, i) => {
            const rect = carpetColumnRect(layout, column);
            const dims: Rect = {
                top: rect.top,
                left: rect.left + rect.width + CarpetColumnGapPx / 2 - half,
                width: handleSizePx,
                height: rect.height,
            };
            handles.push({
                id: `${rootNode.id}-${i + 1}`,
                parentNodeId: rootNode.id,
                parentIndex: i + 1,
                transform: this.carpetTransform(dims, setTransform(dims, true, false)),
                flexDirection: FlexDirection.Row,
                centerPx: dims.left + half,
            });
        });
        return handles;
    }

    // ---- actions ---------------------------------------------------------------------------------------------------

    // In 360 view a panel opened any way (insert, or a split beside another panel) is laid at the end of the carpet;
    // vertical splits stay in their column. Returns the action the layout should run instead, or the action itself.
    rewriteAction(action: LayoutTreeAction, rootNode: LayoutNode): LayoutTreeAction {
        if (!this.wanted || rootNode == null) {
            return action;
        }
        let newNode: LayoutNode = null;
        let focused = false;
        switch (action?.type) {
            case LayoutTreeActionType.InsertNode:
            case LayoutTreeActionType.InsertNodeAtIndex: {
                const insert = action as LayoutTreeInsertNodeAction | LayoutTreeInsertNodeAtIndexAction;
                if (insert.magnified) {
                    return action;
                }
                newNode = insert.node;
                focused = !!insert.focused;
                break;
            }
            case LayoutTreeActionType.SplitHorizontal: {
                const split = action as LayoutTreeSplitHorizontalAction;
                newNode = split.newNode;
                focused = !!split.focused;
                break;
            }
            default:
                return action;
        }
        if (newNode == null) {
            return action;
        }
        // A split after the root's last top-level child appends a column (or wraps a lone panel or stack in a row).
        const lastColumn =
            rootNode.flexDirection === FlexDirection.Row && rootNode.children?.length
                ? rootNode.children[rootNode.children.length - 1]
                : rootNode;
        const rtn: LayoutTreeSplitHorizontalAction = {
            type: LayoutTreeActionType.SplitHorizontal,
            targetNodeId: lastColumn.id,
            newNode,
            position: "after",
            focused,
        };
        return rtn;
    }

    // Called once the layout has placed newly added blocks: the carpet scrolls to the last one laid on it.
    onBlocksAdded(blockIds: string[]): void {
        if (this.layout == null || !blockIds?.length) {
            return;
        }
        const node = this.layoutModel.getNodeByBlockId(blockIds[blockIds.length - 1]);
        const columnId = node == null ? null : this.carpetColumnOf(node.id);
        if (columnId != null) {
            this.scrollToColumn(columnId);
        }
    }

    // ---- membership ------------------------------------------------------------------------------------------------

    // The carpet column holding a node (the column itself or a panel inside it), or null for the fixed zone.
    carpetColumnOf(nodeId: string): string {
        const layout = this.layout;
        const rootNode = this.layoutModel.treeState?.rootNode;
        if (layout == null || rootNode == null || !nodeId) {
            return null;
        }
        for (const column of layout.columns) {
            const columnNode = findNode(rootNode, column.nodeId);
            if (columnNode != null && findNode(columnNode, nodeId) != null) {
                return column.nodeId;
            }
        }
        return null;
    }

    isInFixedZone(nodeId: string): boolean {
        const layout = this.layout;
        const rootNode = this.layoutModel.treeState?.rootNode;
        if (layout == null || rootNode == null) {
            return false;
        }
        const fixedNode = findNode(rootNode, layout.fixedNodeId);
        return fixedNode != null && findNode(fixedNode, nodeId) != null;
    }

    // ---- resizing --------------------------------------------------------------------------------------------------

    // The horizontal offset to add to a pointer for a Wave handle drawn on the carpet (a split inside a carpet column).
    pointerOffsetFor(parentNodeId: string): number {
        if (this.layout == null || this.layoutModel.getter(this.layoutModel.additionalProps)?.[parentNodeId] == null) {
            return 0;
        }
        return this.carpetColumnOf(parentNodeId) != null ? this.scrollLeft : 0;
    }

    // Handles the root's handles in 360 view: they set the fixed zone's width or a carpet column's, never the tree's
    // sizes (the normal layout stays as it was). Returns false for every other handle.
    onResizeMove(handle: ResizeHandleProps, clientX: number): boolean {
        const layout = this.layout;
        const rootNode = this.layoutModel.treeState?.rootNode;
        if (layout == null || rootNode == null || handle.parentNodeId !== rootNode.id) {
            return false;
        }
        const isGrip = handle.id === this.gripHandleId(rootNode);
        if (!isGrip && layout.fixedNodeId === rootNode.id) {
            return false;
        }
        const container = this.layoutModel.displayContainerRef.current?.getBoundingClientRect();
        if (container == null) {
            return true;
        }
        const x = clientX - container.left;
        if (isGrip) {
            this.dragFixedPx = clampFixedPx(x - CarpetMarginPx / 2, container.width);
        } else {
            const column = layout.columns[handle.parentIndex - 1];
            if (column == null) {
                return true;
            }
            const columnNode = findNode(rootNode, column.nodeId);
            const kind = carpetColumnKind(cachedBlockView(columnLeadLeaf(columnNode)?.data?.blockId));
            const left = layout.viewport.left + column.x - this.scrollLeft;
            const px = clampColumnPx(x - left - CarpetColumnGapPx / 2, layout.viewport.width);
            this.dragColumn = { nodeId: column.nodeId, kind, px };
        }
        const resizing: LayoutTreeResizeNodeAction = { type: LayoutTreeActionType.ResizeNode, resizeOperations: [] };
        this.layoutModel.setter(this.layoutModel.pendingTreeAction.throttledValueAtom, resizing);
        this.layoutModel.updateTree(false);
        return true;
    }

    onResizeEnd(): boolean {
        if (this.dragFixedPx == null && this.dragColumn == null) {
            return false;
        }
        if (this.dragFixedPx != null) {
            const px = this.dragFixedPx;
            this.savedFixedPx = px;
            const tabId = this.tabId;
            if (tabId != null) {
                fireAndForget(() => setTabFixedPx(tabId, px));
            }
        }
        if (this.dragColumn != null) {
            rememberPanelWidth(this.dragColumn.kind, this.dragColumn.px);
        }
        this.dragFixedPx = null;
        this.dragColumn = null;
        this.layoutModel.setter(this.layoutModel.pendingTreeAction.throttledValueAtom, undefined);
        this.layoutModel.updateTree(false);
        return true;
    }

    // ---- scrolling ---------------------------------------------------------------------------------------------------

    private rootElement(): HTMLElement {
        return this.layoutModel.displayContainerRef.current?.parentElement ?? null;
    }

    scrollTo(scrollLeft: number): void {
        this.cancelSmoothScroll();
        this.setScroll(scrollLeft);
    }

    scrollBy(dx: number): void {
        this.scrollTo(this.scrollLeft + dx);
    }

    // Glides the carpet so the column is fully in view (a newly laid panel, a focused one, a scrubber click).
    scrollToColumn(columnId: string, smooth = true): void {
        if (this.layout == null) {
            return;
        }
        const target = scrollToRevealColumn(this.layout, columnId, this.scrollLeft);
        if (target === this.scrollLeft) {
            return;
        }
        if (!smooth) {
            this.scrollTo(target);
            return;
        }
        this.cancelSmoothScroll();
        const from = this.scrollLeft;
        const start = performance.now();
        const step = (now: number) => {
            const t = Math.min(1, (now - start) / SmoothScrollMs);
            const eased = 1 - Math.pow(1 - t, 3);
            this.setScroll(from + (target - from) * eased);
            this.smoothFrame = t < 1 ? requestAnimationFrame(step) : null;
        };
        this.smoothFrame = requestAnimationFrame(step);
    }

    private cancelSmoothScroll() {
        if (this.smoothFrame != null) {
            cancelAnimationFrame(this.smoothFrame);
            this.smoothFrame = null;
        }
    }

    private setScroll(scrollLeft: number) {
        const next = clampScroll(this.layout, scrollLeft);
        if (next === this.scrollLeft) {
            return;
        }
        this.scrollLeft = next;
        this.markScrolling();
        this.scheduleScrollWrite();
    }

    private markScrolling() {
        const root = this.rootElement();
        if (root == null) {
            return;
        }
        root.dataset.mtCarpetScrolling = "";
        if (this.settleTimer != null) {
            clearTimeout(this.settleTimer);
        }
        this.settleTimer = setTimeout(() => {
            this.settleTimer = null;
            delete root.dataset.mtCarpetScrolling;
        }, ScrollSettleMs);
    }

    // One write per frame: the CSS variable every carpet node follows, the edge attributes and the atom.
    private scheduleScrollWrite() {
        if (this.scrollFrame != null) {
            return;
        }
        this.scrollFrame = requestAnimationFrame(() => {
            this.scrollFrame = null;
            this.writeScroll();
        });
    }

    private writeScroll() {
        const root = this.rootElement();
        const scrollLeft = this.scrollLeft;
        if (root != null) {
            root.style.setProperty(CarpetScrollVar, `${scrollLeft}px`);
            const layout = this.layout;
            const atStart = layout == null || scrollLeft <= 0.5;
            const atEnd = layout == null || scrollLeft >= layout.maxScroll - 0.5;
            if (atStart) root.dataset.mtCarpetAtStart = "";
            else delete root.dataset.mtCarpetAtStart;
            if (atEnd) root.dataset.mtCarpetAtEnd = "";
            else delete root.dataset.mtCarpetAtEnd;
        }
        if (globalStore.get(this.scrollLeftAtom) !== scrollLeft) {
            globalStore.set(this.scrollLeftAtom, scrollLeft);
        }
    }

    private revealFocusedNode() {
        if (this.layout == null) {
            return;
        }
        const focused = globalStore.get(this.layoutModel.focusedNode);
        const columnId = focused == null ? null : this.carpetColumnOf(focused.id);
        if (columnId != null) {
            this.scrollToColumn(columnId);
        }
    }
}
