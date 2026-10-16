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
import { ResizeSettleMs } from "./view360-decision";
import { View360FixedPxMetaKey, View360MetaKey, View360PinsMetaKey } from "./view360-meta";
import { View360Model } from "./view360-model";

const settingAtom = vi.hoisted(() => ({ current: null as unknown }));
const terminalFloor = vi.hoisted(() => ({ px: null as number }));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    settingAtom.current = atom<string>("auto");
    return { getSettingsKeyAtom: () => settingAtom.current };
});
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(() => Promise.resolve()) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("../toast-store", () => ({ showToast: vi.fn() }));

function metaWrites(): Record<string, unknown>[] {
    return vi.mocked(RpcApi.SetMetaCommand).mock.calls.map((c) => c[1].meta as Record<string, unknown>);
}

vi.mock("../panel-size/panel-size-store", () => ({
    cachedBlockView: (blockId: string) => (blockId === "b-b" ? "web" : "term"),
    currentPanelSizes: () => ({ web: { width: 700 } }),
    currentTerminalFloorPx: () => terminalFloor.px,
    clearTerminalFloor: vi.fn(() => (terminalFloor.px = null)),
    isTerminalLeaf: (node: LayoutNode) => !node.children?.length && node.data?.blockId !== "b-b",
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

    it("enters when a panel opened leaves no room for the terminal floor (#731), and reports what fits", () => {
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

    it("asks before readjusting when only the terminal floor keeps the panels apart (#733)", () => {
        terminalFloor.px = 900;
        try {
            const root = rowOf(2);
            const { model, layoutModel } = makeModel(true, root);
            model.evaluate(root, boundsOf(1200));
            expect(model.requestLeave()).toEqual({ kind: "readjust" });
            expect(globalStore.get(model.exitAskAtom)).toEqual({ kind: "readjust" });
            expect(metaWrites()).toEqual([]);
            // "Stay in 360 view"
            model.closeExitAsk();
            expect(globalStore.get(model.exitAskAtom)).toBeNull();
            expect(model.active).toBe(true);
            // "Readjust every size": the floor cleared, the columns sharing the width, back to automatic.
            model.requestLeave();
            model.readjustAndLeave();
            expect(terminalFloor.px).toBeNull();
            expect(globalStore.get(model.exitAskAtom)).toBeNull();
            expect(layoutModel.treeReducer).toHaveBeenCalledWith({
                type: LayoutTreeActionType.ResizeNode,
                resizeOperations: [
                    { nodeId: "c0", size: 50 },
                    { nodeId: "c1", size: 50 },
                ],
            });
            expect(metaWrites()).toEqual([{ [View360MetaKey]: null }]);
        } finally {
            terminalFloor.px = null;
        }
    });

    it("widens the fixed zone past half of the window to keep the terminal floor (#733)", () => {
        terminalFloor.px = 1000;
        try {
            const root = rowOf(2);
            const { model } = makeModel(true, root);
            model.evaluate(root, boundsOf(1600));
            expect(model.computeLayout(root, boundsOf(1600)).fixed.width).toBe(1000);
            // No room left for a readable carpet column: half of the window again.
            expect(model.computeLayout(root, boundsOf(1300)).fixed.width).toBe(650);
        } finally {
            terminalFloor.px = null;
        }
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
