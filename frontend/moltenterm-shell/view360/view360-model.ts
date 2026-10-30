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
import {
    cachedBlockView,
    currentFirstColumnFloorPx,
    currentPanelSizes,
    rememberPanelWidth,
    setFirstColumnFloor,
} from "../panel-size/panel-size-store";
import { showToast } from "../toast-store";
import { gestureStepEvent, GestureSteps, initialGestureSteps } from "../wheel-gesture";
import {
    canPinBeside,
    CarpetColumnGapPx,
    carpetColumnKind,
    carpetColumnRect,
    CarpetLayout,
    CarpetMarginPx,
    carpetNodeTransform,
    carpetScrollStops,
    CarpetScrollVar,
    carpetSplitPlace,
    clampColumnPx,
    clampFixedDragPx,
    clampFixedPx,
    clampScroll,
    columnLeadLeaf,
    computeCarpetLayout,
    defaultCarpetWidthPx,
    FixedBounds,
    FixedColumn,
    fixedDragBoundsPx,
    NoRoomReason,
    PinMode,
    Rect,
    scrollToRevealColumn,
    sideColumnBoundsPx,
    splitCarpetColumns,
    visibleCarpetColumnIds,
} from "./carpet-model";
import { narrowWindowAtom } from "../narrow-window";
import {
    besideZonePx,
    effectivePlaces,
    equalizePlaceCount,
    equalParts,
    nextScrollStop,
    PlaceOption,
    placeOptions,
    placeScrollPx,
    placesFit,
    placesFixedPx,
    placesStartIndex,
    placeWidthPx,
    WheelStepPx,
} from "./carpet-places";
import { showPlacesToast } from "./carpet-places-toast";
import {
    CarpetGroup,
    GroupAll,
    groupedPins,
    groupOffered,
    GroupPages,
    groupPinPlan,
    type GroupPin,
} from "./carpet-group";
import {
    countBeside,
    handPins,
    hasGroupPins,
    partPinnedColumns,
    PinnedColumn,
    TabPins,
    withoutPin,
    withPin,
    withPinWidth,
} from "./pin-model";
import { PinText } from "./pin-text";
import { ScreenModel } from "./screen-store";
import type { ScreenInfo } from "./screen-threshold";
import {
    anyColumnTooTight,
    autoMinColumns,
    AutoMinColumns,
    autoWants,
    carpetSlotWidthsPx,
    columnFractions,
    columnMinimumsPx,
    columnsParent,
    decideView360,
    exitView360,
    fitsAtCurrentFloors,
    fitsAtReadableMinimums,
    normalColumnPxs,
    normalizeView360Setting,
    overThreshold,
    rememberedFixedPx,
    ResizeSettleMs,
    restoredColumnSizes,
    sameFractions,
    sharedColumnSizes,
    topColumns,
    View360Decision,
    View360Exit,
    View360SettingKey,
} from "./view360-decision";
import {
    setTabFixedPx,
    setTabFractions,
    setTabPins,
    setTabView360,
    storedFixedPx,
    storedFractions,
    storedGroup,
    storedPins,
    storedPlaces,
    tabManualView360,
    View360PlacesState,
    writePlacesState,
} from "./view360-meta";

const SmoothScrollMs = 260;
// Transitions stay off this long after the last scroll step, so the panels follow the scroll without lag.
const ScrollSettleMs = 140;
// What hovering a fixed column's handle says when it cannot move (#829).
const NoRoomKeys: Record<NoRoomReason, string> = {
    floor: "view360.grip.noRoomFloor",
    window: "view360.grip.noRoomWindow",
    columns: "view360.grip.noRoomColumns",
};

export type CarpetRootChild = { rect: Rect; carpet: boolean; pinned?: boolean };

// Where a panel is drawn in 360 view: in the first column, on the carpet, or pinned to the fixed zone (FR-SHELL-067).
export type PanelPlacement = "first" | "carpet" | PinMode;

// What a 360 × N changes, kept for its Undo (FR-SHELL-123-AC8).
export type PlacesSnapshot = {
    places: number;
    group: CarpetGroup;
    pins: TabPins;
    grippedFixedPx: number;
    savedFixedPx: number;
    carpetPx: Map<string, number>;
    scrollLeft: number;
    focusNodeId: string;
};

function sameIds(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((id, i) => id === b[i]);
}

function samePlacements(a: Record<string, PanelPlacement>, b: Record<string, PanelPlacement>): boolean {
    const aKeys = Object.keys(a ?? {});
    return aKeys.length === Object.keys(b ?? {}).length && aKeys.every((k) => a[k] === b?.[k]);
}

function leafBlockIds(node: LayoutNode): string[] {
    if (node == null) {
        return [];
    }
    if (!node.children?.length) {
        return node.data?.blockId ? [node.data.blockId] : [];
    }
    return node.children.flatMap(leafBlockIds);
}

export class View360Model {
    layoutModel: LayoutModel;
    tabAtom: Atom<Tab>;

    // The mode (FR-SHELL-066): the setting, the tab's manual choice, and what the layout last measured.
    settingAtom: Atom<string>;
    manualAtom: Atom<boolean>;
    autoOnAtom: PrimitiveAtom<boolean> = atom(false);
    // More columns than this screen's threshold, and columns that do not fit even at their readable minimums (#1083).
    columnsOverAtom: PrimitiveAtom<boolean> = atom(false);
    cannotFitAtom: PrimitiveAtom<boolean> = atom(false);
    // "360 view beyond N columns" on the screen the window is on (#1083).
    thresholdAtom: Atom<number>;
    // The screen the window is on (ScreenModel's): a test instance sets it to emulate another screen.
    screenAtom: PrimitiveAtom<ScreenInfo>;
    columnCountAtom: PrimitiveAtom<number> = atom(0);
    // Bumped on each automatic switch, for its short glow.
    signalAtom: PrimitiveAtom<number> = atom(0);
    decisionAtom: Atom<View360Decision>;
    activeAtom: Atom<boolean>;
    // Turning the view off asks first (#733): the confirmation ("readjust") or the "close panels first" message
    // ("blocked") on screen, null when none is.
    exitAskAtom: PrimitiveAtom<View360Exit> = atom(null) as PrimitiveAtom<View360Exit>;
    // The geometry of the last layout pass, null when the tab is not drawn in 360 view.
    layoutAtom: PrimitiveAtom<CarpetLayout> = atom(null) as PrimitiveAtom<CarpetLayout>;
    scrollLeftAtom: PrimitiveAtom<number> = atom(0);
    visibleColumnIdsAtom: Atom<string[]>;
    fixedNodeIdAtom: Atom<string>;
    // The panels pinned to the fixed zone, from the tab's meta (or this window's last write, ahead of its round trip).
    pinsAtom: Atom<TabPins>;
    // Block id -> where it is drawn, while the tab is drawn in 360 view (empty otherwise).
    placementsAtom: PrimitiveAtom<Record<string, PanelPlacement>> = atom({}) as PrimitiveAtom<
        Record<string, PanelPlacement>
    >;
    pendingPinsAtom: PrimitiveAtom<TabPins> = atom(null) as PrimitiveAtom<TabPins>;
    // Block id -> where it would be drawn in 360 view, measured on every pass, in the normal layout too: the header's
    // "Store on the carpet" button shows on every panel outside the fixed zone (FR-SHELL-123).
    rolesAtom: PrimitiveAtom<Record<string, PanelPlacement>> = atom({}) as PrimitiveAtom<
        Record<string, PanelPlacement>
    >;
    // The view's 360 × N (FR-SHELL-123): from the tab's meta, or this window's last write ahead of its round trip
    // ({ n: null } a write that forgets it).
    pendingPlacesAtom: PrimitiveAtom<{ n: number }> = atom(null) as PrimitiveAtom<{ n: number }>;
    placesAtom: Atom<number>;
    // The places drawn at the last pass: the view's N, or fewer while the window is too narrow for N (AC7); null when
    // the view has no N or is not drawn in 360 view.
    shownPlacesAtom: PrimitiveAtom<number> = atom(null) as PrimitiveAtom<number>;
    // The view's "360 on the pages" (FR-SHELL-124): from the tab's meta, or this window's last write ahead of its round
    // trip.
    pendingGroupAtom: PrimitiveAtom<{ group: CarpetGroup }> = atom(null) as PrimitiveAtom<{ group: CarpetGroup }>;
    groupAtom: Atom<CarpetGroup>;

    layout: CarpetLayout = null;
    // The tab's width at the last layout pass.
    layoutWidth = 0;
    scrollLeft = 0;
    // The fixed zone's width as this window last set it, ahead of the tab meta's round trip.
    savedFixedPx: number = null;
    // The first column's floor at the last pass (#733, #848), 0 without one.
    fixedNeedPx = 0;
    // The first column's width and the columns pinned beside it (besideZonePx) at the last pass.
    lastFixedPx: number = null;
    besidePx = 0;
    // Widths being dragged, applied until the drag ends.
    dragFixedPx: number = null;
    dragColumn: { nodeId: string; kind: string; px: number } = null;
    dragPin: { nodeId: string; blockId: string; px: number } = null;

    scrollFrame: number = null;
    settleTimer: ReturnType<typeof setTimeout> = null;
    smoothFrame: number = null;
    rootChildren: Map<string, CarpetRootChild> = new Map();

    // The automatic decision's last inputs: a new column count switches at once, a width change once it holds.
    lastColumnCount: number = null;
    // Each column's minimum at the last pass, the first column's floor included (#731, #848), with the width and gap it was measured at.
    lastColumnMins: number[] = [];
    lastEvalWidth = 0;
    lastEvalGap = 0;
    settleTimer360: ReturnType<typeof setTimeout> = null;
    applySettled = false;
    inLayoutPass = false;

    // The developer's proportions (#1083): the shares of the top-level columns, taken while the tab is drawn in the
    // normal layout within the threshold, as this window last wrote them (the tab's meta holds them across restarts).
    savedFractions: number[] = null;
    // Whether the last layout pass drew the tab in 360 view: leaving it gives the proportions back.
    drawnActive = false;
    // Carpet columns dragged during this 360 view, by node id: a drag wins over the remembered proportions.
    carpetPx: Map<string, number> = new Map();
    // The fixed zone's width set by the grip during this 360 view, null while it follows the proportions.
    grippedFixedPx: number = null;
    // Each carpet column's slot width at the last pass, from the remembered proportions.
    slotPx: Map<string, number> = new Map();
    // After a 360 × N, the carpet column to show in the first place once the next pass laid it (AC6); after its Undo,
    // the scroll position and the focus to give back.
    pendingStart: { columnId: string } = null;
    pendingRestore: { scrollLeft: number; focusNodeId: string } = null;
    // The wheel's whole-panel steps while a 360 × N is on (AC7): one per gesture.
    wheelGesture: GestureSteps = initialGestureSteps();
    // Where the carpet's glide ends, while it glides.
    glideTarget: number = null;

    constructor(layoutModel: LayoutModel, tabAtom: Atom<Tab>) {
        this.layoutModel = layoutModel;
        this.tabAtom = tabAtom;
        this.settingAtom = getSettingsKeyAtom(View360SettingKey as keyof SettingsType) as Atom<string>;
        this.manualAtom = atom((get) => tabManualView360(get(tabAtom)));
        this.thresholdAtom = ScreenModel.getInstance().thresholdAtom;
        this.screenAtom = ScreenModel.getInstance().screenAtom;
        const metaPlacesAtom = selectAtom(tabAtom, (tab) => storedPlaces(tab));
        this.placesAtom = atom((get) => {
            const pending = get(this.pendingPlacesAtom);
            return pending != null ? pending.n : get(metaPlacesAtom);
        });
        globalStore.sub(metaPlacesAtom, () => globalStore.set(this.pendingPlacesAtom, null));
        const metaGroupAtom = selectAtom(tabAtom, (tab) => storedGroup(tab));
        this.groupAtom = atom((get) => get(this.pendingGroupAtom)?.group ?? get(metaGroupAtom));
        globalStore.sub(metaGroupAtom, () => globalStore.set(this.pendingGroupAtom, null));
        this.decisionAtom = atom((get) =>
            decideView360({
                setting: normalizeView360Setting(get(this.settingAtom)),
                manual: get(this.manualAtom),
                autoOn: get(this.autoOnAtom),
                columnsOver: get(this.columnsOverAtom),
                cannotFit: get(this.cannotFitAtom),
                columnCount: get(this.columnCountAtom),
                narrowWindow: get(narrowWindowAtom),
                places: get(this.placesAtom),
            })
        );
        // Another N redraws the carpet, also while the view was already in 360 view.
        globalStore.sub(this.placesAtom, () => {
            if (!this.inLayoutPass) {
                this.layoutModel.updateTree();
            }
        });
        // Another screen, or another threshold chosen for it: the decision is taken again.
        globalStore.sub(this.thresholdAtom, () => this.layoutModel.updateTree());
        // The window crossing the narrow threshold too (FR-SHELL-109).
        globalStore.sub(narrowWindowAtom, () => this.layoutModel.updateTree());
        this.activeAtom = selectAtom(this.decisionAtom, (d) => d.active);
        const visibleAtom = atom((get) => visibleCarpetColumnIds(get(this.layoutAtom), get(this.scrollLeftAtom)));
        this.visibleColumnIdsAtom = selectAtom(visibleAtom, (ids) => ids, sameIds);
        this.fixedNodeIdAtom = atom((get) => get(this.layoutAtom)?.fixedNodeId ?? null);
        // A switch decided inside a layout pass is already drawn by that pass.
        globalStore.sub(this.activeAtom, () => {
            if (!this.inLayoutPass) {
                this.layoutModel.updateTree();
            }
        });
        const metaPinsAtom = selectAtom(
            tabAtom,
            (tab) => storedPins(tab),
            (a, b) => JSON.stringify(a) === JSON.stringify(b)
        );
        this.pinsAtom = atom((get) => get(this.pendingPinsAtom) ?? get(metaPinsAtom));
        // The meta caught up with this window's write (or another window wrote): the meta is the truth again.
        globalStore.sub(metaPinsAtom, () => globalStore.set(this.pendingPinsAtom, null));
        globalStore.sub(this.pinsAtom, () => {
            if (this.active) {
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

    // The tab's manual choice: true on demand, false off under the always setting, null follows the setting again.
    setManual(choice: boolean): void {
        const tabId = this.tabId;
        if (tabId == null || choice === globalStore.get(this.manualAtom)) {
            return;
        }
        fireAndForget(() => setTabView360(tabId, choice));
    }

    // The tab's button (#733): on turns the view on on demand; off is guarded (requestLeave).
    setActive(on: boolean): void {
        if (on) {
            this.setManual(true);
            return;
        }
        this.requestLeave();
    }

    toggle(): void {
        this.setActive(!this.active);
    }

    // Turning the view off (#733, #1083): left at once whenever the columns fit at their readable minimums, with the
    // remembered proportions; otherwise the "close panels first" message, and the view stays.
    requestLeave(): View360Exit {
        const exit = exitView360(this.lastColumnMins.length, this.lastEvalWidth, this.lastEvalGap);
        if (exit.kind === "leave") {
            this.leave();
        } else {
            globalStore.set(this.exitAskAtom, exit);
        }
        return exit;
    }

    closeExitAsk(): void {
        globalStore.set(this.exitAskAtom, null);
    }

    // Back to the normal layout; the proportions come back with the next layout pass (restoreProportions). When the
    // threshold, the first column's floor or the always setting would turn the view straight back on, the tab is
    // turned off by hand (until its columns drop back to the threshold); otherwise it follows the automatic decision
    // again, its leaving margin reset.
    private leave() {
        const count = this.lastColumnMins.length;
        const holds =
            globalStore.get(this.columnsOverAtom) ||
            normalizeView360Setting(globalStore.get(this.settingAtom)) === "always" ||
            this.autoWantsNow(false, count, this.lastEvalWidth, this.lastEvalGap, this.lastColumnMins);
        globalStore.set(this.autoOnAtom, false);
        // Leaving forgets the view's 360 × N (FR-SHELL-123-AC10) and its grouping, whose pins leave with it
        // (FR-SHELL-124-AC4).
        this.dropGrouping();
        this.writePlaces(null);
        this.setManual(holds ? false : null);
        this.layoutModel.updateTree();
    }

    // ---- the developer's proportions (#1083) --------------------------------------------------------------------

    rememberedFractions(): number[] {
        return this.savedFractions ?? storedFractions(globalStore.get(this.tabAtom));
    }

    // Called on each pass drawn in the normal layout within the threshold: what the developer's splitters say.
    private rememberFractions(rootNode: LayoutNode) {
        const columns = topColumns(rootNode);
        if (columns.length < 2) {
            return;
        }
        const fractions = columnFractions(columns.map((c) => c.size));
        if (!fractions.length || sameFractions(fractions, this.rememberedFractions())) {
            return;
        }
        this.savedFractions = fractions;
        const tabId = this.tabId;
        if (tabId != null) {
            fireAndForget(() => setTabFractions(tabId, fractions));
        }
    }

    // Leaving 360 view: the columns take back the proportions the developer set, never a readjusted share. Without
    // remembered proportions, only a column that would fall under its minimum makes the columns share the width.
    private restoreProportions(rootNode: LayoutNode) {
        const parent = columnsParent(rootNode);
        if (parent == null) {
            return;
        }
        const children = parent.children;
        let sizes = restoredColumnSizes(this.rememberedFractions(), children.length);
        if (sizes == null) {
            const mins = this.lastColumnMins;
            const normalPxs = normalColumnPxs(
                children.map((c) => c.size),
                this.lastEvalWidth,
                this.lastEvalGap
            );
            if (mins.length !== children.length || !anyColumnTooTight(normalPxs, mins)) {
                return;
            }
            sizes = sharedColumnSizes(mins, this.lastEvalWidth, this.lastEvalGap);
        }
        if (sameFractions(columnFractions(children.map((c) => c.size)), columnFractions(sizes))) {
            return;
        }
        // Set on the tree for the pass being drawn, then through the reducer so the layout keeps it.
        children.forEach((c, i) => (c.size = sizes[i]));
        const resize: LayoutTreeResizeNodeAction = {
            type: LayoutTreeActionType.ResizeNode,
            resizeOperations: children.map((c, i) => ({ nodeId: c.id, size: sizes[i] })),
        };
        setTimeout(() => this.layoutModel.treeReducer(resize), 0);
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
        // Taken before the column count changes: the automatic gate (#1225) flips the state with the count alone.
        const before = this.active;
        globalStore.set(this.columnCountAtom, count);
        const columnMins = columnMinimumsPx(count, currentFirstColumnFloorPx());
        this.lastColumnMins = columnMins;
        this.lastEvalWidth = width;
        this.lastEvalGap = gap;
        this.measureRoles(rootNode);

        // The screen's column threshold (#1083) switches at once: a column opened or closed, another screen.
        const threshold = globalStore.get(this.thresholdAtom);
        const prevCount = this.lastColumnCount;
        globalStore.set(this.columnsOverAtom, count >= AutoMinColumns && overThreshold(count, threshold));
        globalStore.set(this.cannotFitAtom, !fitsAtReadableMinimums(count, width, gap));
        // Turned off by hand beyond the threshold, the tab follows the automatic decision again once its columns drop
        // back to the threshold, unless the readable minimums would turn the view straight back on.
        if (
            prevCount != null &&
            overThreshold(prevCount, threshold) &&
            !overThreshold(count, threshold) &&
            globalStore.get(this.manualAtom) === false &&
            normalizeView360Setting(globalStore.get(this.settingAtom)) === "auto" &&
            !this.autoWantsNow(false, count, width, gap, columnMins)
        ) {
            this.setManual(null);
        }

        const prevOn = globalStore.get(this.autoOnAtom);
        const want = this.autoWantsNow(prevOn, count, width, gap, columnMins);
        const first = this.lastColumnCount == null;
        const countChanged = !first && count !== this.lastColumnCount;
        this.lastColumnCount = count;
        if (!first && this.active !== before && globalStore.get(this.decisionAtom).source === "auto") {
            globalStore.set(this.signalAtom, globalStore.get(this.signalAtom) + 1);
        }
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

    // The automatic rule (autoWants) for this window. In a narrow window (FR-SHELL-109) fewer than three columns count
    // their readable minimums only: a large first-column floor beside one other column is #1225's false trip.
    private autoWantsNow(prevOn: boolean, count: number, width: number, gap: number, columnMins: number[]): boolean {
        if (globalStore.get(narrowWindowAtom) && count < AutoMinColumns) {
            return autoWants(prevOn, count, width, gap, undefined, autoMinColumns(true));
        }
        return autoWants(prevOn, count, width, gap, columnMins);
    }

    // Whether the tab's columns, as last measured, fit side by side at their minimums with the terminal floor (#733).
    fitsAtCurrentFloors(marginPx = 0): boolean {
        return fitsAtCurrentFloors(this.lastColumnMins, this.lastEvalWidth, this.lastEvalGap, marginPx);
    }

    // Whether they would fit at their readable minimums alone, once the terminal floor is cleared (#733).
    fitsAtReadableMinimums(marginPx = 0): boolean {
        return fitsAtReadableMinimums(this.lastColumnMins.length, this.lastEvalWidth, this.lastEvalGap, marginPx);
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

    // The width a column takes on the carpet (also what a column keeps when one is added beside it, #732).
    columnWidthPx(column: LayoutNode): number {
        if (this.dragColumn?.nodeId === column.id) {
            return this.dragColumn.px;
        }
        const px = this.carpetPx.get(column.id) ?? this.slotPx.get(column.id);
        if (px != null) {
            return px;
        }
        const kind = carpetColumnKind(cachedBlockView(columnLeadLeaf(column)?.data?.blockId));
        return rememberedPanelPx(currentPanelSizes(), kind, "width") ?? defaultCarpetWidthPx(kind);
    }

    // Called by the layout before it walks the tree: the geometry of the root's columns, or null for the normal layout.
    computeLayout(rootNode: LayoutNode, bounds: Rect): CarpetLayout {
        const split = this.active ? splitCarpetColumns(rootNode) : null;
        this.rootChildren = new Map();
        this.layoutWidth = bounds?.width ?? 0;
        if (split == null || !(bounds?.width > 0)) {
            if (!this.active) {
                this.savedFixedPx = null;
                this.grippedFixedPx = null;
                this.carpetPx.clear();
                if (bounds?.width > 0) {
                    if (this.drawnActive) {
                        this.restoreProportions(rootNode);
                    } else if (!globalStore.get(this.columnsOverAtom)) {
                        this.rememberFractions(rootNode);
                    }
                    this.drawnActive = false;
                }
            }
            this.setLayout(null);
            this.setPlacements({});
            this.setShownPlaces(null);
            if (this.pendingRestore != null) {
                const focusNodeId = this.pendingRestore.focusNodeId;
                this.pendingRestore = null;
                if (focusNodeId != null) {
                    setTimeout(() => this.layoutModel.focusNode(focusNodeId), 0);
                }
            }
            return null;
        }
        this.drawnActive = true;
        const floorPx = currentFirstColumnFloorPx() ?? 0;
        this.fixedNeedPx = floorPx;
        // The grip being dragged sets the floor (#848): below the current one, the drag wins until it ends.
        const fixedNeedPx = this.dragFixedPx != null ? Math.min(floorPx, this.dragFixedPx) : floorPx;
        const fractions = this.rememberedFractions();
        const { carpet, pinned } = partPinnedColumns(split.carpet, globalStore.get(this.pinsAtom));
        const pinWidthPx = (p: PinnedColumn) =>
            this.dragPin?.nodeId === p.node.id ? this.dragPin.px : (p.pin.px ?? this.columnWidthPx(p.node));
        // The view's 360 × N (FR-SHELL-123): equal parts for the fixed zone and the places, as many places as fit.
        const places = globalStore.get(this.placesAtom);
        const besidePx = besideZonePx(pinned.filter((p) => p.pin.mode === "beside").map(pinWidthPx));
        const shownPlaces = places == null ? null : effectivePlaces(places, bounds.width, fixedNeedPx, besidePx);
        // The developer's proportions (#1083): the fixed zone keeps the first column's share of the width, unless the
        // grip moved it during this view.
        let fixedPx =
            this.dragFixedPx ??
            this.grippedFixedPx ??
            (shownPlaces != null ? placesFixedPx(bounds.width, shownPlaces, fixedNeedPx, besidePx) : null) ??
            rememberedFixedPx(fractions, bounds.width, this.gapPx()) ??
            this.storedFixedPx();
        if (fixedPx == null) {
            // Entering the view, the fixed zone keeps the first column's normal width, then holds it while panels
            // are laid on the carpet.
            const total = rootNode.children.reduce((acc, c) => acc + c.size, 0);
            fixedPx = split.carpet.length && total > 0 ? (split.fixed.size / total) * bounds.width : bounds.width;
            this.savedFixedPx = clampFixedPx(fixedPx, bounds.width, fixedNeedPx);
            // Saved at once (#614 follow-up): before, the width chosen on entering was kept only once dragged.
            const tabId = this.tabId;
            const px = this.savedFixedPx;
            if (tabId != null && split.carpet.length) {
                fireAndForget(() => setTabFixedPx(tabId, px));
            }
        }
        this.lastFixedPx = fixedPx;
        this.besidePx = besidePx;
        const carpetInput = () => ({
            width: bounds.width,
            height: bounds.height,
            fixedNodeId: split.fixed.id,
            fixedPx,
            fixedNeedPx,
            columns: carpet.map((c) => ({ nodeId: c.id, widthPx: this.columnWidthPx(c) })),
            pins: pinned.map((p) => ({ nodeId: p.node.id, mode: p.pin.mode, widthPx: pinWidthPx(p) })),
        });
        // The first place before this pass, kept when the places change width (a window resized, AC7).
        const anchorIndex = shownPlaces != null ? this.placesAnchorIndex() : -1;
        const previousSlots = this.slotPx;
        this.slotPx = new Map();
        let layout = computeCarpetLayout(carpetInput());
        // The carpet slots keep the developer's proportions (#1083), sized once the carpet's own width is known; under
        // a 360 × N every carpet column takes the width of one place, so the carpet always shows N whole panels.
        const indexes = carpet.map((c) => split.carpet.indexOf(c) + 1);
        const room = layout.viewport.width;
        const slots =
            shownPlaces != null
                ? carpet.map(() => placeWidthPx(layout.viewport.width, shownPlaces))
                : carpetSlotWidthsPx(fractions, indexes, room, CarpetColumnGapPx);
        if (slots != null) {
            carpet.forEach((c, i) => this.slotPx.set(c.id, slots[i]));
            layout = computeCarpetLayout(carpetInput());
        }
        if (split.fixed !== rootNode) {
            for (const column of layout.fixedColumns) {
                this.rootChildren.set(column.nodeId, {
                    rect: column.rect,
                    carpet: false,
                    pinned: column.mode !== "first",
                });
            }
        }
        for (const column of layout.columns) {
            this.rootChildren.set(column.nodeId, { rect: carpetColumnRect(layout, column), carpet: true });
        }
        const placements: Record<string, PanelPlacement> = {};
        leafBlockIds(split.fixed).forEach((id) => (placements[id] = "first"));
        carpet.forEach((c) => leafBlockIds(c).forEach((id) => (placements[id] = "carpet")));
        pinned.forEach((p) => leafBlockIds(p.node).forEach((id) => (placements[id] = p.pin.mode)));
        const resized =
            shownPlaces != null &&
            carpet.some((c) => previousSlots.get(c.id) != null && previousSlots.get(c.id) !== this.slotPx.get(c.id));
        this.setLayout(layout);
        this.setPlacements(placements);
        this.setShownPlaces(shownPlaces);
        this.settlePlacesScroll(layout, shownPlaces, resized ? anchorIndex : -1);
        return layout;
    }

    // ---- 360 × N (FR-SHELL-123) ------------------------------------------------------------------------------------

    // Equalize in 360 view (FR-SHELL-073, #1479): the fixed zone and every visible place take the same share, the
    // equal parts of a 360 × N (AC5). Under a 360 × N the widths dragged by hand give way to the view's own equal
    // parts; in the plain 360 view the fixed zone and every carpet column are set to them. Returns each place's
    // width, or null when the view already shows equal parts (the auto mode calls it after every pass).
    equalizeParts(): number {
        const layout = this.layout;
        const width = this.layoutWidth;
        const dragging = this.dragFixedPx != null || this.dragColumn != null || this.dragPin != null;
        if (layout == null || !layout.columns.length || !(width > 0) || dragging) {
            return null;
        }
        const shown = globalStore.get(this.shownPlacesAtom);
        const n = equalizePlaceCount(layout, shown, width, this.fixedNeedPx, this.besidePx);
        const parts = equalParts(width, n, this.fixedNeedPx, this.besidePx);
        // Decided on what the view was asked for, not on the drawn widths, which the layout may round or clamp: the
        // auto mode would otherwise ask again after every pass.
        if (shown != null) {
            if (this.grippedFixedPx == null && this.carpetPx.size === 0) {
                return null;
            }
            this.grippedFixedPx = null;
            this.carpetPx.clear();
            return parts.placePx;
        }
        const fixedEqual = this.lastFixedPx != null && Math.abs(this.lastFixedPx - parts.fixedPx) <= 1;
        const columnsEqual = layout.columns.every(
            (c) => this.carpetPx.get(c.nodeId) === parts.placePx || Math.abs(c.width - parts.placePx) <= 1
        );
        if (fixedEqual && columnsEqual) {
            return null;
        }
        this.grippedFixedPx = parts.fixedPx;
        this.savedFixedPx = parts.fixedPx;
        const tabId = this.tabId;
        if (tabId != null) {
            fireAndForget(() => setTabFixedPx(tabId, parts.fixedPx));
        }
        layout.columns.forEach((c) => this.carpetPx.set(c.nodeId, parts.placePx));
        return parts.placePx;
    }

    private setShownPlaces(n: number) {
        if (globalStore.get(this.shownPlacesAtom) !== n) {
            globalStore.set(this.shownPlacesAtom, n);
        }
    }

    // Where the carpet rests after a pass: the start place an apply asked for, the scroll an Undo gives back, or, once
    // the places changed width, the same first place as before.
    private settlePlacesScroll(layout: CarpetLayout, shownPlaces: number, anchorIndex: number) {
        if (this.pendingRestore != null) {
            const { scrollLeft, focusNodeId } = this.pendingRestore;
            this.pendingRestore = null;
            this.scrollTo(scrollLeft);
            if (focusNodeId != null) {
                setTimeout(() => this.layoutModel.focusNode(focusNodeId), 0);
            }
            return;
        }
        if (shownPlaces == null) {
            return;
        }
        if (this.pendingStart != null) {
            const index = layout.columns.findIndex((c) => c.nodeId === this.pendingStart.columnId);
            this.pendingStart = null;
            this.scrollTo(placeScrollPx(layout, placesStartIndex(index, layout.columns.length, shownPlaces)));
            return;
        }
        if (anchorIndex >= 0 && this.smoothFrame == null) {
            this.scrollTo(placeScrollPx(layout, anchorIndex));
        }
    }

    // The carpet column at the left of the view: the first one whose start is in view.
    private placesAnchorIndex(): number {
        const layout = this.layout;
        if (layout == null || !layout.columns.length) {
            return -1;
        }
        const index = layout.columns.findIndex((c) => c.x + c.width / 2 > this.scrollLeft);
        return index < 0 ? layout.columns.length - 1 : index;
    }

    // Block id -> where each panel would be drawn in 360 view, measured on every pass (the normal layout too).
    private measureRoles(rootNode: LayoutNode) {
        const split = splitCarpetColumns(rootNode);
        const roles: Record<string, PanelPlacement> = {};
        if (split != null) {
            const { carpet, pinned } = partPinnedColumns(split.carpet, globalStore.get(this.pinsAtom));
            leafBlockIds(split.fixed).forEach((id) => (roles[id] = "first"));
            carpet.forEach((c) => leafBlockIds(c).forEach((id) => (roles[id] = "carpet")));
            pinned.forEach((p) => leafBlockIds(p.node).forEach((id) => (roles[id] = p.pin.mode)));
        }
        if (!samePlacements(globalStore.get(this.rolesAtom), roles)) {
            globalStore.set(this.rolesAtom, roles);
        }
    }

    places(): number {
        return globalStore.get(this.placesAtom);
    }

    private writePlaces(n: number) {
        if (this.places() === n) {
            return;
        }
        globalStore.set(this.pendingPlacesAtom, { n });
        const tabId = this.tabId;
        if (tabId != null) {
            fireAndForget(() => writePlacesState(tabId, { places: n }));
        }
    }

    // N, the grouping and the pins in one meta write, so a restart never finds one without the others. pins undefined
    // leaves them as they are.
    private writePlacesWithGroup(n: number, group: CarpetGroup, pins: TabPins) {
        const state: View360PlacesState = {};
        if (this.places() !== n) {
            state.places = n;
            globalStore.set(this.pendingPlacesAtom, { n });
        }
        if (this.group() !== group) {
            state.group = group;
            globalStore.set(this.pendingGroupAtom, { group });
        }
        if (pins !== undefined) {
            state.pins = pins;
            globalStore.set(this.pendingPinsAtom, pins);
        }
        const tabId = this.tabId;
        if (tabId != null && Object.keys(state).length) {
            fireAndForget(() => writePlacesState(tabId, state));
        }
    }

    // ---- 360 on the pages (FR-SHELL-124) -----------------------------------------------------------------------

    group(): CarpetGroup {
        return globalStore.get(this.groupAtom);
    }

    private treeCarpetColumns(): LayoutNode[] {
        return splitCarpetColumns(this.layoutModel.treeState?.rootNode)?.carpet ?? [];
    }

    private viewOf = (blockId: string): string => cachedBlockView(blockId);

    // Whether the chooser shows "On the carpet: All panels · The pages" (AC1).
    groupOffered(): boolean {
        return groupOffered(this.treeCarpetColumns(), globalStore.get(this.pinsAtom), this.viewOf);
    }

    // The grouping a 360 × N applies when none is chosen (the view menu, the command panel): the view's own, while the
    // choice makes a difference.
    effectiveGroup(): CarpetGroup {
        return this.group() === GroupPages && this.groupOffered() ? GroupPages : GroupAll;
    }

    // The pins the view would hold under a grouping, the pins of panels no longer in the tab dropped.
    private pinsUnder(group: CarpetGroup): TabPins {
        const pins = groupedPins(
            group,
            this.treeCarpetColumns(),
            globalStore.get(this.pinsAtom),
            this.viewOf,
            this.lastEvalWidth,
            this.groupRoom()
        );
        const live = this.liveBlockIds();
        if (live == null) {
            return pins;
        }
        const ids = new Set(live);
        return Object.fromEntries(Object.entries(pins).filter(([id]) => ids.has(id)));
    }

    // Where the grouping would pin the other panels (beside or under the agent), for the chooser to say it before the
    // click (AC3).
    groupPlan(): GroupPin[] {
        return groupPinPlan(
            this.treeCarpetColumns(),
            globalStore.get(this.pinsAtom),
            this.viewOf,
            this.lastEvalWidth,
            this.groupRoom()
        );
    }

    // A grouping pin goes beside only while the pages keep one readable place next to the fixed zone: the half-window
    // rule alone would let the first column's 520 px and a beside column leave the pages too narrow for any number.
    private groupRoom() {
        const hand = partPinnedColumns(this.treeCarpetColumns(), handPins(globalStore.get(this.pinsAtom))).pinned;
        const width = this.lastEvalWidth;
        const floorPx = currentFirstColumnFloorPx() ?? 0;
        return {
            handBesidePx: hand.filter((p) => p.pin.mode === "beside").map((p) => p.pin.px ?? this.pinnedRestPx(p.node)),
            widthOf: (column: LayoutNode) => this.pinnedRestPx(column),
            fits: (besideWidthsPx: number[]) => placesFit(width, 1, floorPx, besideZonePx(besideWidthsPx)),
        };
    }

    // How many columns lie on the carpet under each choice (the segment's counts).
    groupCarpetCount(group: CarpetGroup): number {
        return this.carpetColumnsNow(group).carpet.length;
    }

    // Leaving the 360 view (AC4): exactly the marked pins leave, the panels go back to the carpet at their place in
    // the tree, and the view forgets its grouping.
    private dropGrouping() {
        const pins = globalStore.get(this.pinsAtom);
        const marked = hasGroupPins(pins);
        if (!marked && this.group() === GroupAll) {
            return;
        }
        const next = handPins(pins);
        if (marked) {
            globalStore.set(this.pendingPinsAtom, next);
        }
        globalStore.set(this.pendingGroupAtom, { group: GroupAll });
        const tabId = this.tabId;
        if (tabId != null) {
            fireAndForget(() => writePlacesState(tabId, { group: GroupAll, ...(marked ? { pins: next } : {}) }));
        }
    }

    // The tree's carpet columns as 360 view would lay them under a grouping: the top-level columns other than the
    // first and the pinned.
    private carpetColumnsNow(group: CarpetGroup = this.effectiveGroup()): { carpet: LayoutNode[]; besidePx: number } {
        const split = splitCarpetColumns(this.layoutModel.treeState?.rootNode);
        if (split == null) {
            return { carpet: [], besidePx: 0 };
        }
        const { carpet, pinned } = partPinnedColumns(split.carpet, this.pinsUnder(group));
        const beside = pinned.filter((p) => p.pin.mode === "beside").map((p) => p.pin.px ?? this.pinnedRestPx(p.node));
        return { carpet, besidePx: besideZonePx(beside) };
    }

    // The width a column takes once pinned beside without a width of its own: never its carpet slot, a place's width
    // under a 360 × N that the pin does not keep.
    private pinnedRestPx(column: LayoutNode): number {
        if (this.slotPx.has(column.id) && !this.carpetPx.has(column.id)) {
            const kind = carpetColumnKind(cachedBlockView(columnLeadLeaf(column)?.data?.blockId));
            return rememberedPanelPx(currentPanelSizes(), kind, "width") ?? defaultCarpetWidthPx(kind);
        }
        return this.columnWidthPx(column);
    }

    // What the chooser offers right now (AC3): computed each time it opens, from the view's width and its columns as
    // the grouping would leave them (with the pages, C counts the pages only and the grouping's beside pins widen the
    // fixed zone).
    placeOptions(group: CarpetGroup = this.effectiveGroup()): PlaceOption[] {
        const { carpet, besidePx } = this.carpetColumnsNow(group);
        return placeOptions(carpet.length, this.lastEvalWidth, currentFirstColumnFloorPx() ?? 0, besidePx);
    }

    // How many columns the developer pinned to the fixed zone (the chooser says they stay).
    pinnedColumnCount(): number {
        const split = splitCarpetColumns(this.layoutModel.treeState?.rootNode);
        return split == null ? 0 : partPinnedColumns(split.carpet, handPins(globalStore.get(this.pinsAtom))).pinned.length;
    }

    // A 360 × N from a panel (AC5, AC6, AC8): the view keeps its N, the fixed zone and the places take equal parts
    // (hand resizes are replaced), the panel takes the first place and gets the focus. With "The pages"
    // (FR-SHELL-124) the other panels are pinned in the same write; "All panels" removes those pins. A message says
    // what happened and offers Undo for 10 s. Returns false when the number is not offered.
    applyPlaces(blockId: string, n: number, group: CarpetGroup = this.effectiveGroup()): boolean {
        const option = this.placeOptions(group).find((o) => o.n === n);
        const column = this.rootColumnOfBlock(blockId);
        if (option == null || !option.offered || column == null) {
            return false;
        }
        const before = this.placesSnapshot();
        this.grippedFixedPx = null;
        this.carpetPx.clear();
        const pins = this.pinsUnder(group);
        const { carpet } = partPinnedColumns(this.treeCarpetColumns(), pins);
        // A panel the grouping pins does not take a place: the first page does.
        const start = carpet.includes(column) ? column : carpet[0];
        this.pendingStart = start == null ? null : { columnId: start.id };
        const pinsChanged = JSON.stringify(pins) !== JSON.stringify(globalStore.get(this.pinsAtom));
        // Another N redraws by itself (placesAtom); otherwise the pass is asked for here.
        const changed = this.places() !== n;
        this.writePlacesWithGroup(n, group, pinsChanged ? pins : undefined);
        if (!changed) {
            this.layoutModel.updateTree();
        }
        const node = this.layoutModel.getNodeByBlockId?.(blockId);
        if (node != null) {
            this.layoutModel.focusNode(node.id);
        }
        showPlacesToast(n, option.stored, () => this.restorePlaces(before));
        return true;
    }

    // The panel a 360 × N chosen from the view's menu starts from: the focused one when it lies on the carpet, the
    // first carpet panel otherwise.
    placesBlockId(): string {
        const focused = globalStore.get(this.layoutModel.focusedNode)?.data?.blockId;
        if (focused != null && globalStore.get(this.rolesAtom)[focused] === "carpet") {
            return focused;
        }
        return leafBlockIds(this.carpetColumnsNow().carpet[0])[0] ?? null;
    }

    // Everything a 360 × N changes, for its Undo.
    placesSnapshot(): PlacesSnapshot {
        return {
            places: this.places(),
            group: this.group(),
            pins: globalStore.get(this.pinsAtom),
            grippedFixedPx: this.grippedFixedPx,
            savedFixedPx: this.savedFixedPx,
            carpetPx: new Map(this.carpetPx),
            scrollLeft: this.scrollLeft,
            focusNodeId: globalStore.get(this.layoutModel.focusedNode)?.id ?? null,
        };
    }

    // Undo (AC8): the exact state before the apply: 360 view on or off and N, pins, fixed zone width, scroll and focus.
    restorePlaces(snapshot: PlacesSnapshot): void {
        this.pendingStart = null;
        this.grippedFixedPx = snapshot.grippedFixedPx;
        this.savedFixedPx = snapshot.savedFixedPx;
        this.carpetPx = new Map(snapshot.carpetPx);
        this.pendingRestore = { scrollLeft: snapshot.scrollLeft, focusNodeId: snapshot.focusNodeId };
        // The grouping and its marked pins come back too (FR-SHELL-124-AC6).
        const pinsChanged = JSON.stringify(snapshot.pins) !== JSON.stringify(globalStore.get(this.pinsAtom));
        const changed = this.places() !== snapshot.places;
        this.writePlacesWithGroup(snapshot.places, snapshot.group, pinsChanged ? snapshot.pins : undefined);
        if (!changed) {
            this.layoutModel.updateTree();
        }
    }

    // ---- wheel steps (AC7) ----------------------------------------------------------------------------------------

    // Under a 360 × N a wheel or trackpad gesture moves the carpet one whole panel: a step once the gesture passes
    // WheelStepPx, then nothing until a new gesture, however long its momentum (#1466). A step taken during a glide
    // goes one panel past the glide's end.
    private wheelStep(dx: number, at: number): void {
        const { state, step } = gestureStepEvent(this.wheelGesture, { dx, at }, WheelStepPx);
        this.wheelGesture = state;
        if (step === 0) {
            return;
        }
        this.glideTo(nextScrollStop(carpetScrollStops(this.layout), this.glideTarget ?? this.scrollLeft, step));
    }

    private setPlacements(placements: Record<string, PanelPlacement>) {
        if (samePlacements(globalStore.get(this.placementsAtom), placements)) {
            return;
        }
        globalStore.set(this.placementsAtom, placements);
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

    fixedHandlePrefix(rootNode: LayoutNode): string {
        return `${rootNode?.id}-mtfixed-`;
    }

    // The first column and the columns pinned beside it, left to right.
    sideBySideFixedColumns(): FixedColumn[] {
        return (this.layout?.fixedColumns ?? [])
            .filter((c) => c.mode !== "stacked")
            .sort((a, b) => a.rect.left - b.rect.left);
    }

    // The drag range of the fixed column a handle sizes: the whole zone when the first column is alone, otherwise what
    // the other columns side by side leave of it.
    fixedColumnBounds(width: number, column: FixedColumn, sideBySide: FixedColumn[]): FixedBounds {
        if (sideBySide.length <= 1 || this.layout == null) {
            return fixedDragBoundsPx(width, this.fixedNeedPx);
        }
        return sideColumnBoundsPx(width, this.fixedNeedPx, this.layout.fixed.width - column.rect.width);
    }

    // Why the handle sizing this fixed column cannot move right now, or null when it can (#829): it says so on hover.
    fixedNoRoom(column: FixedColumn): NoRoomReason {
        if (column == null) {
            return null;
        }
        return this.fixedColumnBounds(this.layoutWidth, column, this.sideBySideFixedColumns()).noRoom ?? null;
    }

    // The grip sizes the last fixed column side by side.
    gripNoRoom(): NoRoomReason {
        const sideBySide = this.sideBySideFixedColumns();
        return this.fixedNoRoom(sideBySide[sideBySide.length - 1]);
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
            stuckTitleKey: NoRoomKeys[this.gripNoRoom()],
        };
        if (layout.fixedNodeId === rootNode.id) {
            return [...waveHandles, gripHandle];
        }
        const handles: ResizeHandleProps[] = [gripHandle];
        // Between fixed columns side by side, a handle sizes the column on its left; the grip sizes the last one.
        this.sideBySideFixedColumns()
            .slice(0, -1)
            .forEach((column, i) => {
                const dims: Rect = {
                    top: 0,
                    left: column.rect.left + column.rect.width + CarpetMarginPx / 2 - half,
                    width: handleSizePx,
                    height: layout.fixed.height,
                };
                handles.push({
                    id: `${this.fixedHandlePrefix(rootNode)}${i}`,
                    parentNodeId: rootNode.id,
                    parentIndex: 0,
                    transform: setTransform(dims, true, false),
                    flexDirection: FlexDirection.Row,
                    centerPx: dims.left + half,
                    stuckTitleKey: NoRoomKeys[this.fixedNoRoom(column)],
                });
            });
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

    // In 360 view a panel opened any way is laid at the end of the carpet, except a split beside a panel, which lands
    // right before or after that panel's column (#677, carpetSplitPlace); vertical splits stay in their column.
    // Returns the action the layout should run instead, or the action itself.
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
                if (split.newNode == null) {
                    return action;
                }
                const place = carpetSplitPlace(rootNode, split.targetNodeId, split.position);
                const beside: LayoutTreeSplitHorizontalAction = {
                    type: LayoutTreeActionType.SplitHorizontal,
                    targetNodeId: place.targetNodeId,
                    newNode: split.newNode,
                    position: place.position,
                    focused: !!split.focused,
                };
                return beside;
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
    // Under a 360 × N only a panel that took the focus is shown (a page opened from a page): one opened without it (an
    // agent's page) waits on the carpet and what the developer looks at stays (FR-SHELL-123-AC11).
    onBlocksAdded(blockIds: string[]): void {
        if (!blockIds?.length) {
            return;
        }
        const last = blockIds[blockIds.length - 1];
        if (globalStore.get(this.shownPlacesAtom) != null) {
            const focusedBlockId = globalStore.get(this.layoutModel.focusedNode)?.data?.blockId;
            if (focusedBlockId !== last) {
                return;
            }
        }
        this.revealBlock(last);
    }

    // Where a panel an agent opens goes under a 360 × N (AC11): after the carpet's last panel, so the places in view
    // stay. Null otherwise: it goes beside the panel it comes from.
    carpetEndBlockId(): string {
        if (this.layout == null || globalStore.get(this.shownPlacesAtom) == null || !this.layout.columns.length) {
            return null;
        }
        const rootNode = this.layoutModel.treeState?.rootNode;
        const last = this.layout.columns[this.layout.columns.length - 1];
        const ids = leafBlockIds(rootNode == null ? null : findNode(rootNode, last.nodeId));
        return ids[ids.length - 1] ?? null;
    }

    // Glides the carpet so the panel's column is fully in view (#747): anything drawn on a panel for the keyboard
    // (the split placement, find) must never land off-screen. Nothing to do outside 360 view or in the fixed zone.
    revealBlock(blockId: string): void {
        if (this.layout == null || !blockId) {
            return;
        }
        const node = this.layoutModel.getNodeByBlockId?.(blockId);
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
        // The first column, and the columns pinned to the fixed zone (always visible: never throttled, not on the
        // scrubber).
        return layout.fixedColumns.some((column) => {
            const fixedNode = findNode(rootNode, column.nodeId);
            return fixedNode != null && findNode(fixedNode, nodeId) != null;
        });
    }

    // ---- pinning (FR-SHELL-067) -----------------------------------------------------------------------------------

    placementOf(blockId: string): PanelPlacement {
        return globalStore.get(this.placementsAtom)[blockId] ?? null;
    }

    private rootColumnOfBlock(blockId: string): LayoutNode {
        const rootNode = this.layoutModel.treeState?.rootNode;
        const node = this.layoutModel.getNodeByBlockId?.(blockId);
        if (rootNode?.children == null || node == null) {
            return null;
        }
        return rootNode.children.find((c) => findNode(c, node.id) != null) ?? null;
    }

    private writePins(pins: TabPins) {
        globalStore.set(this.pendingPinsAtom, pins);
        const tabId = this.tabId;
        if (tabId != null) {
            fireAndForget(() => setTabPins(tabId, pins));
        }
    }

    private liveBlockIds(): string[] {
        return globalStore.get(this.tabAtom)?.blockids ?? null;
    }

    // Pins a carpet panel's column. A pin beside that the fixed zone cannot hold within half of the window is refused
    // with a short message; returns whether the panel was pinned.
    pin(blockId: string, mode: PinMode): boolean {
        const placement = this.placementOf(blockId);
        if (placement == null || placement === "first" || placement === mode) {
            return false;
        }
        const column = this.rootColumnOfBlock(blockId);
        if (column == null) {
            return false;
        }
        if (mode === "beside") {
            const rootNode = this.layoutModel.treeState?.rootNode;
            const split = splitCarpetColumns(rootNode);
            const pins = globalStore.get(this.pinsAtom);
            const beside = countBeside(partPinnedColumns(split?.carpet ?? [], pins).pinned);
            if (!canPinBeside(this.layoutWidth, beside)) {
                showToast({
                    id: "view360-pin-refused",
                    kind: "info",
                    title: PinText.refusedTitle,
                    message: PinText.refusedMessage,
                });
                return false;
            }
        }
        this.writePins(withPin(globalStore.get(this.pinsAtom), column, blockId, mode, this.liveBlockIds()));
        return true;
    }

    unpin(blockId: string): boolean {
        const placement = this.placementOf(blockId);
        if (placement !== "beside" && placement !== "stacked") {
            return false;
        }
        const column = this.rootColumnOfBlock(blockId);
        if (column == null) {
            return false;
        }
        this.writePins(withoutPin(globalStore.get(this.pinsAtom), column, this.liveBlockIds()));
        const columnId = column.id;
        // Back on the carpet at its place: the carpet glides to it once the layout has laid it there.
        setTimeout(() => this.scrollToColumn(columnId), 0);
        return true;
    }

    // The shortcut: a carpet panel is pinned beside, a pinned one goes back to the carpet. False when the panel is
    // neither (the key then does nothing here).
    togglePin(blockId: string): boolean {
        const placement = this.placementOf(blockId);
        if (placement === "carpet") {
            this.pin(blockId, "beside");
            return true;
        }
        if (placement === "beside" || placement === "stacked") {
            return this.unpin(blockId);
        }
        return false;
    }

    // ---- resizing --------------------------------------------------------------------------------------------------

    // The horizontal offset to add to a pointer for a Wave handle drawn on the carpet (a split inside a carpet column).
    pointerOffsetFor(parentNodeId: string): number {
        if (this.layout == null || this.layoutModel.getter(this.layoutModel.additionalProps)?.[parentNodeId] == null) {
            return 0;
        }
        return this.carpetColumnOf(parentNodeId) != null ? this.scrollLeft : 0;
    }

    // ---- drag and drop ---------------------------------------------------------------------------------------------

    private onCarpet(nodeId: string): boolean {
        return (
            this.layout != null &&
            !!nodeId &&
            !!this.layoutModel.getter(this.layoutModel.additionalProps)?.[nodeId]?.moltenCarpet
        );
    }

    // The scroll to add to a pointer over a node drawn on the carpet: drop targets compare the pointer with the node's
    // rect before scrolling.
    pointerScrollFor(nodeId: string): number {
        return this.onCarpet(nodeId) ? this.scrollLeft : 0;
    }

    // The drop placeholder over a node drawn on the carpet follows the scroll and the clip like the node itself.
    placeholderTransform(targetNodeId: string, rect: Rect, base: CSSProperties): CSSProperties {
        return this.onCarpet(targetNodeId) ? this.carpetTransform(rect, base) : base;
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
        const prefix = this.fixedHandlePrefix(rootNode);
        const isFixedHandle = handle.id.startsWith(prefix);
        if (!isGrip && layout.fixedNodeId === rootNode.id) {
            return false;
        }
        const container = this.layoutModel.displayContainerRef.current?.getBoundingClientRect();
        if (container == null) {
            return true;
        }
        const x = clientX - container.left;
        const sideBySide = this.sideBySideFixedColumns();
        if ((isGrip || isFixedHandle) && sideBySide.length > 1) {
            const index = isGrip ? sideBySide.length - 1 : Number(handle.id.slice(prefix.length));
            const column = sideBySide[index];
            if (column == null) {
                return true;
            }
            // The column takes what the others leave of half of the window, never less than its minimum.
            const { min, max } = this.fixedColumnBounds(container.width, column, sideBySide);
            const px = Math.round(Math.min(Math.max(x - column.rect.left - CarpetMarginPx / 2, min), max));
            if (column.mode === "first") {
                this.dragFixedPx = px;
            } else {
                const columnNode = findNode(rootNode, column.nodeId);
                const blockId = leafBlockIds(columnNode).find((id) => globalStore.get(this.pinsAtom)[id] != null);
                this.dragPin = { nodeId: column.nodeId, blockId, px };
            }
        } else if (isGrip) {
            this.dragFixedPx = clampFixedDragPx(x - CarpetMarginPx / 2, container.width, this.fixedNeedPx);
        } else if (isFixedHandle) {
            return true;
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
        if (this.dragFixedPx == null && this.dragColumn == null && this.dragPin == null) {
            return false;
        }
        if (this.dragPin != null) {
            const { blockId, px } = this.dragPin;
            if (blockId != null) {
                this.writePins(withPinWidth(globalStore.get(this.pinsAtom), blockId, px));
            }
            this.dragPin = null;
        }
        if (this.dragFixedPx != null) {
            const px = this.dragFixedPx;
            this.savedFixedPx = px;
            this.grippedFixedPx = px;
            const tabId = this.tabId;
            if (tabId != null) {
                fireAndForget(() => setTabFixedPx(tabId, px));
            }
            setFirstColumnFloor(px);
        }
        if (this.dragColumn != null) {
            this.carpetPx.set(this.dragColumn.nodeId, this.dragColumn.px);
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

    // A wheel or trackpad scroll: free on the carpet, by whole panels under a 360 × N (FR-SHELL-123-AC7). `at` is the
    // event's time on this page's clock: the gesture's pauses are read from it, not from when a busy thread got to it.
    scrollBy(dx: number, at = performance.now()): void {
        if (this.layout != null && globalStore.get(this.shownPlacesAtom) != null) {
            this.wheelStep(dx, at);
            return;
        }
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
        this.glideTo(target);
    }

    private glideTo(target: number) {
        this.cancelSmoothScroll();
        const from = this.scrollLeft;
        if (target === from) {
            return;
        }
        this.glideTarget = target;
        const start = performance.now();
        const step = (now: number) => {
            const t = Math.min(1, (now - start) / SmoothScrollMs);
            const eased = 1 - Math.pow(1 - t, 3);
            this.setScroll(from + (target - from) * eased);
            this.smoothFrame = t < 1 ? requestAnimationFrame(step) : null;
            if (this.smoothFrame == null) {
                this.glideTarget = null;
            }
        };
        this.smoothFrame = requestAnimationFrame(step);
    }

    private cancelSmoothScroll() {
        if (this.smoothFrame != null) {
            cancelAnimationFrame(this.smoothFrame);
            this.smoothFrame = null;
        }
        this.glideTarget = null;
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
