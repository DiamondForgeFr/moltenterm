// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { findNode } from "@/layout/lib/layoutNode";
import {
    FlexDirection,
    LayoutTreeActionType,
    type LayoutNode,
    type LayoutTreeInsertNodeAction,
    type LayoutTreeSplitHorizontalAction,
    type LayoutTreeSplitVerticalAction,
} from "@/layout/lib/types";
import { atom, type PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showToast } from "../toast-store";
import { CarpetReservePx, scrollToRevealColumn, visibleCarpetColumnIds } from "./carpet-model";
import { ResizeSettleMs } from "./view360-decision";
import { View360FixedPxMetaKey, View360FractionsMetaKey, View360MetaKey, View360PinsMetaKey } from "./view360-meta";
import { View360Model } from "./view360-model";

const settingAtom = vi.hoisted(() => ({ current: null as unknown }));
const terminalFloor = vi.hoisted(() => ({ px: null as number }));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    settingAtom.current = atom<string>("auto");
    return { getSettingsKeyAtom: () => settingAtom.current };
});
// The screen's column threshold (#1083): high by default, so the readable-minimum tests below see that rule alone.
const screenThreshold = vi.hoisted(() => ({ atom: null as unknown }));
vi.mock("./screen-store", async () => {
    const { atom } = await import("jotai");
    screenThreshold.atom = atom(8);
    return { ScreenModel: { getInstance: () => ({ thresholdAtom: screenThreshold.atom }) } };
});

function setThreshold(n: number) {
    globalStore.set(screenThreshold.atom as PrimitiveAtom<number>, n);
}
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(() => Promise.resolve()) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("../toast-store", () => ({ showToast: vi.fn() }));

function metaWrites(): Record<string, unknown>[] {
    return vi.mocked(RpcApi.SetMetaCommand).mock.calls.map((c) => c[1].meta as Record<string, unknown>);
}

vi.mock("../panel-size/panel-size-store", () => ({
    cachedBlockView: (blockId: string) => (blockId === "b-b" ? "web" : "term"),
    currentPanelSizes: () => ({ web: { width: 700 } }),
    currentFirstColumnFloorPx: () => terminalFloor.px,
    clearFirstColumnFloor: vi.fn(() => (terminalFloor.px = null)),
    setFirstColumnFloor: vi.fn((px: number) => (terminalFloor.px = px)),
    rememberPanelWidth: vi.fn(),
}));
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));

function leaf(id: string): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size: 10, data: { blockId: `b-${id}` } };
}

// on: the tab's manual choice (true, false) or null to follow the setting.
function makeModel(on: boolean, rootNode: LayoutNode) {
    const tabAtom = atom({
        oid: "tab-1",
        meta: on == null ? {} : { [View360MetaKey]: on },
    } as unknown as Tab) as PrimitiveAtom<Tab>;
    const layoutModel = {
        focusedNode: atom(null as LayoutNode),
        updateTree: vi.fn(),
        treeReducer: vi.fn(),
        treeState: { rootNode },
        displayContainerRef: { current: null },
    } as unknown as LayoutModel;
    return { model: new View360Model(layoutModel, tabAtom), tabAtom, layoutModel };
}

function setSetting(value: string) {
    globalStore.set(settingAtom.current as PrimitiveAtom<string>, value);
}

function rowOf(n: number): LayoutNode {
    return {
        id: "root",
        flexDirection: FlexDirection.Row,
        size: 10,
        children: Array.from({ length: n }, (_, i) => leaf(`c${i}`)),
    };
}

function boundsOf(width: number) {
    return { top: 0, left: 0, width, height: 900 };
}

const bounds = { top: 0, left: 0, width: 1600, height: 900 };
const wideBounds = { top: 0, left: 0, width: 2400, height: 900 };

describe("View360Model", () => {
    it("lays an inserted panel at the end of the carpet in 360 view", () => {
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("a"), leaf("b")],
        };
        const { model } = makeModel(true, root);
        const node = leaf("new");
        const insert: LayoutTreeInsertNodeAction = {
            type: LayoutTreeActionType.InsertNode,
            node,
            magnified: false,
            focused: true,
        };
        const rewritten = model.rewriteAction(insert, root) as LayoutTreeSplitHorizontalAction;
        expect(rewritten).toEqual({
            type: LayoutTreeActionType.SplitHorizontal,
            targetNodeId: "b",
            newNode: node,
            position: "after",
            focused: true,
        });
    });

    it("lays a split from the fixed zone as the carpet's first column, on either side (#677)", () => {
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("a"), leaf("b")],
        };
        const { model } = makeModel(true, root);
        for (const position of ["before", "after"] as const) {
            const split: LayoutTreeSplitHorizontalAction = {
                type: LayoutTreeActionType.SplitHorizontal,
                targetNodeId: "a",
                newNode: leaf("new"),
                position,
            };
            const rewritten = model.rewriteAction(split, root) as LayoutTreeSplitHorizontalAction;
            expect([rewritten.targetNodeId, rewritten.position]).toEqual(["a", "after"]);
        }
    });

    it("lays a split from a carpet panel right before or after its column (#677)", () => {
        const stack: LayoutNode = {
            id: "stack",
            flexDirection: FlexDirection.Column,
            size: 10,
            children: [leaf("s1"), leaf("s2")],
        };
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("a"), stack, leaf("c")],
        };
        const { model } = makeModel(true, root);
        const newNode = leaf("new");
        const splitLeft: LayoutTreeSplitHorizontalAction = {
            type: LayoutTreeActionType.SplitHorizontal,
            targetNodeId: "s2",
            newNode,
            position: "before",
            focused: true,
        };
        const left = model.rewriteAction(splitLeft, root);
        expect(left).toEqual({
            type: LayoutTreeActionType.SplitHorizontal,
            targetNodeId: "stack",
            newNode,
            position: "before",
            focused: true,
        });
        const splitRight: LayoutTreeSplitHorizontalAction = {
            type: LayoutTreeActionType.SplitHorizontal,
            targetNodeId: "s1",
            newNode,
            position: "after",
        };
        const right = model.rewriteAction(splitRight, root) as LayoutTreeSplitHorizontalAction;
        expect([right.targetNodeId, right.position]).toEqual(["stack", "after"]);
    });

    it("wraps a lone panel so the new one becomes the first carpet column", () => {
        const root = leaf("only");
        const { model } = makeModel(true, root);
        const insert: LayoutTreeInsertNodeAction = {
            type: LayoutTreeActionType.InsertNode,
            node: leaf("new"),
            magnified: false,
            focused: false,
        };
        expect((model.rewriteAction(insert, root) as LayoutTreeSplitHorizontalAction).targetNodeId).toBe("only");
    });

    it("keeps vertical splits in their column and every action outside 360 view", () => {
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("a"), leaf("b")],
        };
        const vertical: LayoutTreeSplitVerticalAction = {
            type: LayoutTreeActionType.SplitVertical,
            targetNodeId: "a",
            newNode: leaf("new"),
            position: "after",
        };
        expect(makeModel(true, root).model.rewriteAction(vertical, root)).toBe(vertical);
        const insert: LayoutTreeInsertNodeAction = {
            type: LayoutTreeActionType.InsertNode,
            node: leaf("new"),
            magnified: false,
            focused: false,
        };
        expect(makeModel(false, root).model.rewriteAction(insert, root)).toBe(insert);
    });

    it("computes the fixed zone and carpet columns only in 360 view", () => {
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [
                { ...leaf("a"), size: 60 },
                { ...leaf("b"), size: 40 },
            ],
        };
        const off = makeModel(false, root).model;
        off.evaluate(root, bounds);
        expect(off.computeLayout(root, bounds)).toBeNull();
        const { model } = makeModel(true, root);
        model.evaluate(root, bounds);
        const layout = model.computeLayout(root, bounds);
        expect(layout.fixedNodeId).toBe("a");
        // The first time, the fixed zone keeps the first column's normal width (60 % of 1600, capped at half).
        expect(layout.fixed.width).toBe(800);
        expect(layout.columns.map((c) => c.nodeId)).toEqual(["b"]);
        // A carpet column takes the width remembered for its kind.
        expect(layout.columns[0].width).toBe(700);
        expect(model.rootChild("a").carpet).toBe(false);
        expect(model.rootChild("b").carpet).toBe(true);
        expect(globalStore.get(model.layoutAtom)).toBe(layout);
        expect(model.isInFixedZone("a")).toBe(true);
        expect(model.carpetColumnOf("b")).toBe("b");
        expect(model.carpetColumnOf("a")).toBeNull();
    });

    it("shifts drag and drop on the scrolled carpet by the scroll, never in the fixed zone (#617)", () => {
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("a"), leaf("b"), leaf("c"), leaf("d")],
        };
        const { model, layoutModel } = makeModel(true, root);
        const props = { a: {}, b: { moltenCarpet: true }, c: { moltenCarpet: true } };
        Object.assign(layoutModel, { additionalProps: atom(props), getter: (a: any) => globalStore.get(a) });
        model.evaluate(root, bounds);
        const layout = model.computeLayout(root, bounds);
        expect(layout.maxScroll).toBeGreaterThan(200);
        model.scrollTo(200);
        expect(model.pointerScrollFor("b")).toBe(200);
        expect(model.pointerScrollFor("a")).toBe(0);
        const rect = { top: 0, left: 900, width: 300, height: 400 };
        const base = { transform: "translate3d(900px, 0px, 0)" };
        expect(model.placeholderTransform("c", rect, base).transform).toContain("var(--mt-carpet-scroll");
        expect(model.placeholderTransform("a", rect, base)).toBe(base);
    });

    it("brings a panel scrolled off the carpet back into view, never moving for the fixed zone (#747)", () => {
        const root = rowOf(8);
        const { model, layoutModel } = makeModel(true, root);
        const leafs = root.children;
        Object.assign(layoutModel, {
            getNodeByBlockId: (blockId: string) => leafs.find((l) => l.data.blockId === blockId) ?? null,
        });
        model.evaluate(root, bounds);
        const layout = model.computeLayout(root, bounds);
        expect(layout.maxScroll).toBeGreaterThan(0);
        model.scrollTo(layout.maxScroll);
        const offCarpet = layout.columns[0].nodeId;
        expect(visibleCarpetColumnIds(layout, layout.maxScroll)).not.toContain(offCarpet);
        const glide = vi.spyOn(model, "scrollToColumn");

        model.revealBlock("b-c0");
        model.revealBlock("b-missing");
        expect(model.isInFixedZone("c0")).toBe(true);
        expect(glide).not.toHaveBeenCalled();

        model.revealBlock(`b-${offCarpet}`);
        expect(glide).toHaveBeenCalledWith(offCarpet);
        expect(scrollToRevealColumn(layout, offCarpet, layout.maxScroll)).toBeLessThan(layout.maxScroll);
    });

    it("never scrolls outside 360 view (#747)", () => {
        const root = rowOf(8);
        const { model, layoutModel } = makeModel(false, root);
        Object.assign(layoutModel, { getNodeByBlockId: () => root.children[3] });
        model.evaluate(root, bounds);
        const glide = vi.spyOn(model, "scrollToColumn");
        model.revealBlock("b-c3");
        expect(glide).not.toHaveBeenCalled();
    });

    it("draws a pinned column in the fixed zone and gives it back to the carpet at its place (FR-SHELL-067)", () => {
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("a"), leaf("b"), leaf("c")],
        };
        const { model, tabAtom, layoutModel } = makeModel(true, root);
        (layoutModel as any).getNodeByBlockId = (blockId: string) => findNode(root, blockId.slice(2));
        globalStore.set(tabAtom, {
            oid: "tab-1",
            blockids: ["b-a", "b-b", "b-c"],
            meta: { [View360MetaKey]: true, [View360PinsMetaKey]: { "b-b": { mode: "beside", px: 360 } } },
        } as unknown as Tab);
        model.evaluate(root, wideBounds);
        let layout = model.computeLayout(root, wideBounds);
        expect(layout.fixedColumns.map((c) => [c.nodeId, c.mode])).toEqual([
            ["a", "first"],
            ["b", "beside"],
        ]);
        expect(layout.fixedColumns[1].rect.width).toBe(360);
        expect(layout.columns.map((c) => c.nodeId)).toEqual(["c"]);
        expect(model.rootChild("b")).toMatchObject({ carpet: false, pinned: true });
        expect(model.isInFixedZone("b")).toBe(true);
        expect(model.carpetColumnOf("b")).toBeNull();
        expect(globalStore.get(model.placementsAtom)).toEqual({ "b-a": "first", "b-b": "beside", "b-c": "carpet" });

        expect(model.unpin("b-b")).toBe(true);
        expect(vi.mocked(RpcApi.SetMetaCommand).mock.calls.at(-1)[1]).toEqual({
            oref: "tab:tab-1",
            meta: { [View360PinsMetaKey]: null },
        });
        layout = model.computeLayout(root, wideBounds);
        expect(layout.columns.map((c) => c.nodeId)).toEqual(["b", "c"]);
        expect(model.placementOf("b-b")).toBe("carpet");

        // Stacked in the first column: the fixed zone keeps its width.
        expect(model.pin("b-c", "stacked")).toBe(true);
        layout = model.computeLayout(root, wideBounds);
        expect(layout.fixedColumns.map((c) => [c.nodeId, c.mode])).toEqual([
            ["a", "first"],
            ["c", "stacked"],
        ]);
        expect(layout.columns.map((c) => c.nodeId)).toEqual(["b"]);
        // The first column is never pinned.
        expect(model.pin("b-a", "beside")).toBe(false);
    });

    it("refuses a pin beside that the fixed zone cannot hold in half of the window", () => {
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("a"), leaf("b"), leaf("c")],
        };
        const { model, layoutModel } = makeModel(true, root);
        (layoutModel as any).getNodeByBlockId = (blockId: string) => findNode(root, blockId.slice(2));
        model.evaluate(root, { ...bounds, width: 1440 });
        model.computeLayout(root, { ...bounds, width: 1440 });
        expect(model.pin("b-b", "beside")).toBe(true);
        model.evaluate(root, { ...bounds, width: 1440 });
        model.computeLayout(root, { ...bounds, width: 1440 });
        expect(model.pin("b-c", "beside")).toBe(false);
        expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ id: "view360-pin-refused" }));
        expect(model.placementOf("b-c")).toBe("carpet");
    });

    it("lays pinned panels out as ordinary panels in normal mode", () => {
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("a"), leaf("b")],
        };
        const { model, tabAtom } = makeModel(false, root);
        globalStore.set(tabAtom, {
            oid: "tab-1",
            meta: { [View360PinsMetaKey]: { "b-b": { mode: "beside" } } },
        } as unknown as Tab);
        expect(model.computeLayout(root, bounds)).toBeNull();
        expect(model.rootChild("b")).toBeNull();
        expect(globalStore.get(model.placementsAtom)).toEqual({});
    });

    it("re-runs the layout when the tab enters or leaves 360 view", () => {
        const root = rowOf(2);
        const { model, tabAtom, layoutModel } = makeModel(false, root);
        model.evaluate(root, boundsOf(1600));
        globalStore.set(tabAtom, { oid: "tab-1", meta: { [View360MetaKey]: true } } as unknown as Tab);
        expect(layoutModel.updateTree).toHaveBeenCalled();
    });

    it("saves the fixed zone's width as soon as the view is entered (#614 follow-up)", () => {
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [
                { ...leaf("a"), size: 60 },
                { ...leaf("b"), size: 40 },
            ],
        };
        vi.mocked(RpcApi.SetMetaCommand).mockClear();
        const { model } = makeModel(true, root);
        model.evaluate(root, bounds);
        model.computeLayout(root, bounds);
        expect(metaWrites()).toContainEqual({ [View360FixedPxMetaKey]: 800 });
    });
});

describe("View360Model mode (FR-SHELL-066)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        setSetting("auto");
        vi.mocked(RpcApi.SetMetaCommand).mockClear();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("enters at once when a panel opened would be too narrow, with the short signal", () => {
        const { model } = makeModel(null, rowOf(2));
        model.evaluate(rowOf(2), boundsOf(1200));
        expect(model.active).toBe(false);
        model.evaluate(rowOf(3), boundsOf(1200));
        expect(model.active).toBe(true);
        expect(globalStore.get(model.decisionAtom).source).toBe("auto");
        expect(globalStore.get(model.signalAtom)).toBe(1);
        // Closing a panel leaves at once too.
        model.evaluate(rowOf(2), boundsOf(1200));
        expect(model.active).toBe(false);
        expect(globalStore.get(model.signalAtom)).toBe(2);
    });

    it("enters when a panel opened leaves no room for the first column's floor (#731, #848), and reports what fits", () => {
        terminalFloor.px = 900;
        try {
            const { model } = makeModel(null, rowOf(1));
            model.evaluate(rowOf(1), boundsOf(1200));
            expect(model.active).toBe(false);
            // 900 (floor) + 360 > 1200, while the readable minimums alone (520 + 360) would fit.
            model.evaluate(rowOf(2), boundsOf(1200));
            expect(model.active).toBe(true);
            expect(model.fitsAtCurrentFloors()).toBe(false);
            expect(model.fitsAtReadableMinimums()).toBe(true);
            terminalFloor.px = null;
            model.evaluate(rowOf(3), boundsOf(1400));
            expect(model.fitsAtCurrentFloors()).toBe(true);
        } finally {
            terminalFloor.px = null;
        }
    });

    it("does not signal the state found when the tab opens", () => {
        const { model } = makeModel(null, rowOf(4));
        model.evaluate(rowOf(4), boundsOf(1200));
        expect(model.active).toBe(true);
        expect(globalStore.get(model.signalAtom)).toBe(0);
    });

    it("switches on a window resize only once the width has held, and not around the threshold", () => {
        const { model, layoutModel } = makeModel(null, rowOf(3));
        const root = rowOf(3);
        model.evaluate(root, boundsOf(1400));
        expect(model.active).toBe(false);
        model.evaluate(root, boundsOf(1200));
        expect(model.active).toBe(false);
        vi.advanceTimersByTime(ResizeSettleMs - 50);
        model.evaluate(root, boundsOf(1220));
        vi.advanceTimersByTime(ResizeSettleMs - 50);
        expect(layoutModel.updateTree).not.toHaveBeenCalled();
        vi.advanceTimersByTime(60);
        expect(layoutModel.updateTree).toHaveBeenCalledTimes(1);
        // The layout pass the timer asked for applies it.
        model.evaluate(root, boundsOf(1220));
        expect(model.active).toBe(true);
        // Back above the minimums but within the margin: stays.
        model.evaluate(root, boundsOf(1260));
        vi.advanceTimersByTime(ResizeSettleMs * 2);
        model.evaluate(root, boundsOf(1260));
        expect(model.active).toBe(true);
    });

    it("lets the always setting decide, a stored never read as automatic, and turns on on demand (#733)", () => {
        const root = rowOf(2);
        const { model, tabAtom } = makeModel(null, root);
        model.evaluate(root, boundsOf(1600));
        expect(model.active).toBe(false);
        setSetting("always");
        expect(model.active).toBe(true);
        setSetting("never");
        expect(model.active).toBe(false);
        // A stored "never" no longer turns the automatic decision off.
        model.evaluate(rowOf(4), boundsOf(1200));
        expect(model.active).toBe(true);
        expect(globalStore.get(model.decisionAtom).source).toBe("auto");
        model.evaluate(root, boundsOf(1600));
        model.toggle();
        expect(metaWrites()).toEqual([{ [View360MetaKey]: true }]);
        globalStore.set(tabAtom, { oid: "tab-1", meta: { [View360MetaKey]: true } } as unknown as Tab);
        expect(model.active).toBe(true);
        expect(globalStore.get(model.decisionAtom).source).toBe("manual");
    });

    it("leaves an on-demand view at once when everything fits, back to automatic (#733)", () => {
        const root = rowOf(2);
        const { model, layoutModel } = makeModel(true, root);
        model.evaluate(root, boundsOf(1600));
        expect(model.active).toBe(true);
        expect(model.requestLeave()).toEqual({ kind: "leave" });
        expect(metaWrites()).toEqual([{ [View360MetaKey]: null }]);
        expect(globalStore.get(model.exitAskAtom)).toBeNull();
        expect(layoutModel.treeReducer).not.toHaveBeenCalled();
        expect(layoutModel.updateTree).toHaveBeenCalled();
    });

    it("turns the always setting off for this tab only while everything fits (#733)", () => {
        setSetting("always");
        const root = rowOf(2);
        const { model } = makeModel(null, root);
        model.evaluate(root, boundsOf(1600));
        expect(model.active).toBe(true);
        model.toggle();
        expect(metaWrites()).toEqual([{ [View360MetaKey]: false }]);
    });

    it("leaves an automatic view inside the leaving margin, the automatic state reset (#733)", () => {
        const root = rowOf(3);
        const { model } = makeModel(null, root);
        model.evaluate(root, boundsOf(1200));
        expect(model.active).toBe(true);
        // 1240 needed: fits at 1260, though within the margin automatic would stay.
        model.evaluate(root, boundsOf(1260));
        expect(model.active).toBe(true);
        expect(model.requestLeave()).toEqual({ kind: "leave" });
        expect(model.active).toBe(false);
        model.evaluate(root, boundsOf(1260));
        expect(model.active).toBe(false);
    });

    it("leaves below the first column's floor without readjusting anything, turned off by hand (#733, #1083)", () => {
        terminalFloor.px = 900;
        try {
            const root = rowOf(2);
            const { model, layoutModel } = makeModel(true, root);
            model.evaluate(root, boundsOf(1200));
            expect(model.requestLeave()).toEqual({ kind: "leave" });
            expect(globalStore.get(model.exitAskAtom)).toBeNull();
            // The floor stays, no size is shared again, and the tab stays off although the floor no longer fits.
            expect(terminalFloor.px).toBe(900);
            expect(layoutModel.treeReducer).not.toHaveBeenCalled();
            expect(metaWrites()).toEqual([{ [View360MetaKey]: false }]);
        } finally {
            terminalFloor.px = null;
        }
    });

    it("widens the fixed zone past half of the window to keep the first column's floor (#733)", () => {
        terminalFloor.px = 1000;
        try {
            const root = rowOf(2);
            const { model } = makeModel(true, root);
            model.evaluate(root, boundsOf(1600));
            expect(model.computeLayout(root, boundsOf(1600)).fixed.width).toBe(1000);
            // No room for the floor and a readable carpet column: the zone keeps as much as the carpet leaves (#829).
            expect(model.computeLayout(root, boundsOf(1300)).fixed.width).toBe(1300 - CarpetReservePx);
        } finally {
            terminalFloor.px = null;
        }
    });

    it("holds a first column that is a browser at the floor: the floor does not depend on its content (#848)", () => {
        terminalFloor.px = 1000;
        try {
            const root: LayoutNode = {
                id: "root",
                flexDirection: FlexDirection.Row,
                size: 10,
                children: [leaf("b"), leaf("c1")],
            };
            const { model } = makeModel(true, root);
            model.evaluate(root, boundsOf(1600));
            expect(model.computeLayout(root, boundsOf(1600)).fixed.width).toBe(1000);
        } finally {
            terminalFloor.px = null;
        }
    });

    it("lets the grip widen and narrow a fixed zone held past half by the floor, setting the floor (#829, #848)", () => {
        terminalFloor.px = 700;
        try {
            const root = rowOf(2);
            const { model, layoutModel } = makeModel(true, root);
            Object.assign(layoutModel, {
                displayContainerRef: { current: { getBoundingClientRect: () => ({ left: 0, width: 1280 }) } },
                setter: vi.fn(),
                pendingTreeAction: { throttledValueAtom: null },
            });
            model.evaluate(root, boundsOf(1280));
            model.computeLayout(root, boundsOf(1280));
            const grip = model.rootResizeHandles(root, 10, [])[0];
            expect(grip.id).toBe(model.gripHandleId(root));
            expect(grip.stuckTitleKey).toBeUndefined();
            expect(model.onResizeMove(grip, 820)).toBe(true);
            expect(model.dragFixedPx).toBe(816);
            expect(model.onResizeMove(grip, 1200)).toBe(true);
            expect(model.dragFixedPx).toBe(1280 - CarpetReservePx);
            // The grip sets the floor, so it narrows below the current one down to the fixed zone's minimum.
            expect(model.onResizeMove(grip, 300)).toBe(true);
            expect(model.dragFixedPx).toBe(520);
            expect(model.computeLayout(root, boundsOf(1280)).fixed.width).toBe(520);
            expect(model.onResizeEnd()).toBe(true);
            expect(terminalFloor.px).toBe(520);
        } finally {
            terminalFloor.px = null;
        }
    });

    it("says on the grip why it cannot move when the window leaves no room (#829)", () => {
        const root = rowOf(2);
        const { model } = makeModel(true, root);
        model.evaluate(root, boundsOf(780));
        model.computeLayout(root, boundsOf(780));
        expect(model.gripNoRoom()).toBe("window");
        expect(model.rootResizeHandles(root, 10, [])[0].stuckTitleKey).toBe("view360.grip.noRoomWindow");
        model.computeLayout(root, boundsOf(1280));
        expect(model.gripNoRoom()).toBeNull();
    });

    it("stays in 360 view when the panels do not fit even at their readable minimums (#733)", () => {
        const root = rowOf(5);
        const { model, layoutModel } = makeModel(true, root);
        model.evaluate(root, boundsOf(1300));
        expect(model.requestLeave()).toEqual({ kind: "blocked", extraColumns: 2 });
        expect(globalStore.get(model.exitAskAtom)).toEqual({ kind: "blocked", extraColumns: 2 });
        expect(metaWrites()).toEqual([]);
        expect(layoutModel.treeReducer).not.toHaveBeenCalled();
        expect(model.active).toBe(true);
    });

    it("lays a panel opened in a single-column tab that wants 360 view on the carpet", () => {
        setSetting("always");
        const root = leaf("only");
        const { model } = makeModel(null, root);
        model.evaluate(root, boundsOf(1600));
        expect(model.active).toBe(false);
        const insert: LayoutTreeInsertNodeAction = {
            type: LayoutTreeActionType.InsertNode,
            node: leaf("new"),
            magnified: false,
            focused: false,
        };
        expect(model.rewriteAction(insert, root).type).toBe(LayoutTreeActionType.SplitHorizontal);
    });
});

function sizedRow(...sizes: number[]): LayoutNode {
    return {
        id: "root",
        flexDirection: FlexDirection.Row,
        size: 10,
        children: sizes.map((size, i) => ({ ...leaf(`c${i}`), size })),
    };
}

// One layout pass, as the layout runs it.
function pass(model: View360Model, root: LayoutNode, width: number) {
    model.evaluate(root, boundsOf(width));
    return model.computeLayout(root, boundsOf(width));
}

describe("View360Model threshold per screen and proportions (#1083)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        setSetting("auto");
        vi.mocked(RpcApi.SetMetaCommand).mockClear();
    });
    afterEach(() => {
        vi.useRealTimers();
        setThreshold(8);
    });

    it("laptop, 2 columns at 40/60: a third panel switches to 360 view, the carpet keeps the 60 % slot", () => {
        setThreshold(2);
        const { model, layoutModel } = makeModel(null, sizedRow(40, 60));
        expect(pass(model, sizedRow(40, 60), 1600)).toBeNull();
        expect(metaWrites()).toContainEqual({ [View360FractionsMetaKey]: [0.4, 0.6] });
        // The split gave the new panel half of the last column: 40/30/30 in the tree.
        const three = sizedRow(40, 30, 30);
        const layout = pass(model, three, 1600);
        expect(model.active).toBe(true);
        expect(globalStore.get(model.decisionAtom)).toMatchObject({ source: "auto", reason: "columns" });
        expect(globalStore.get(model.signalAtom)).toBe(1);
        // The fixed zone keeps 40 %, each carpet panel takes the whole carpet like the 60 % column did.
        expect(layout.fixed.width).toBe(640);
        expect(layout.columns.map((c) => c.width)).toEqual([layout.viewport.width, layout.viewport.width]);
        // Entering touched nothing in the tree.
        expect(three.children.map((c) => c.size)).toEqual([40, 30, 30]);
        // Closing the third panel: back to the normal layout with 40/60, not the 40/30 the tree was left with.
        const back = sizedRow(40, 30);
        expect(pass(model, back, 1600)).toBeNull();
        expect(model.active).toBe(false);
        expect(back.children.map((c) => c.size)).toEqual([40, 60]);
        vi.runAllTimers();
        expect(layoutModel.treeReducer).toHaveBeenCalledWith({
            type: LayoutTreeActionType.ResizeNode,
            resizeOperations: [
                { nodeId: "c0", size: 40 },
                { nodeId: "c1", size: 60 },
            ],
        });
    });

    it("wide screen, 3 columns at 30/35/35: a fourth shows two carpet panels side by side at the 35 % slots", () => {
        setThreshold(3);
        const { model } = makeModel(null, sizedRow(30, 35, 35));
        expect(pass(model, sizedRow(30, 35, 35), 3000)).toBeNull();
        const layout = pass(model, sizedRow(30, 35, 35, 35), 3000);
        expect(model.active).toBe(true);
        expect(layout.fixed.width).toBe(900);
        const slot = (layout.viewport.width - 12) / 2;
        expect(layout.columns.map((c) => c.width)).toEqual([slot, slot, slot]);
    });

    it("keeps the readable minimums as a safety net within the threshold", () => {
        setThreshold(3);
        const { model } = makeModel(null, rowOf(3));
        // 3 columns in 1100 px do not fit at 520 + 360 + 360.
        pass(model, rowOf(3), 1100);
        expect(model.active).toBe(true);
        expect(globalStore.get(model.decisionAtom).reason).toBe("fit");
    });

    it("turned off by hand beyond the threshold stays off, and follows the threshold again once back to it", () => {
        setThreshold(2);
        const { model, tabAtom } = makeModel(null, rowOf(2));
        pass(model, rowOf(2), 1600);
        pass(model, rowOf(3), 1600);
        expect(model.active).toBe(true);
        expect(model.requestLeave()).toEqual({ kind: "leave" });
        expect(metaWrites()).toContainEqual({ [View360MetaKey]: false });
        globalStore.set(tabAtom, { oid: "tab-1", meta: { [View360MetaKey]: false } } as unknown as Tab);
        pass(model, rowOf(4), 1600);
        expect(model.active).toBe(false);
        vi.mocked(RpcApi.SetMetaCommand).mockClear();
        pass(model, rowOf(2), 1600);
        expect(metaWrites()).toContainEqual({ [View360MetaKey]: null });
    });

    it("takes the decision again when the screen or its threshold changes", () => {
        setThreshold(3);
        const { model, layoutModel } = makeModel(null, rowOf(3));
        pass(model, rowOf(3), 1600);
        expect(model.active).toBe(false);
        vi.mocked(layoutModel.updateTree).mockClear();
        setThreshold(2);
        expect(layoutModel.updateTree).toHaveBeenCalled();
        pass(model, rowOf(3), 1600);
        expect(model.active).toBe(true);
    });

    it("lets a carpet column dragged during the view keep its width over the slot", () => {
        setThreshold(2);
        const { model, layoutModel } = makeModel(null, sizedRow(40, 60));
        Object.assign(layoutModel, {
            displayContainerRef: { current: { getBoundingClientRect: () => ({ left: 0, width: 1600 }) } },
            setter: vi.fn(),
            pendingTreeAction: { throttledValueAtom: null },
        });
        pass(model, sizedRow(40, 60), 1600);
        const root = sizedRow(40, 30, 30);
        const layout = pass(model, root, 1600);
        const handle = model.rootResizeHandles(root, 10, [])[1];
        const column = layout.columns[0];
        expect(model.onResizeMove(handle, layout.viewport.left + column.x + 500)).toBe(true);
        expect(model.onResizeEnd()).toBe(true);
        const after = pass(model, root, 1600);
        expect(after.columns[0].width).toBeLessThan(layout.columns[0].width);
        expect(after.columns[1].width).toBe(layout.columns[1].width);
    });
});
