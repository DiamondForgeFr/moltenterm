// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import type { LayoutModel } from "@/layout/lib/layoutModel";
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
import { ResizeSettleMs } from "./view360-decision";
import { View360FixedPxMetaKey, View360MetaKey } from "./view360-meta";
import { View360Model } from "./view360-model";

const settingAtom = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    settingAtom.current = atom<string>("auto");
    return { getSettingsKeyAtom: () => settingAtom.current };
});
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(() => Promise.resolve()) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

function metaWrites(): Record<string, unknown>[] {
    return vi.mocked(RpcApi.SetMetaCommand).mock.calls.map((c) => c[1].meta as Record<string, unknown>);
}
vi.mock("../panel-size/panel-size-store", () => ({
    cachedBlockView: (blockId: string) => (blockId === "b-b" ? "web" : "term"),
    currentPanelSizes: () => ({ web: { width: 700 } }),
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

    it("lays a split beside the fixed zone at the end of the carpet too", () => {
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("a"), leaf("b")],
        };
        const { model } = makeModel(true, root);
        const split: LayoutTreeSplitHorizontalAction = {
            type: LayoutTreeActionType.SplitHorizontal,
            targetNodeId: "a",
            newNode: leaf("new"),
            position: "after",
        };
        expect((model.rewriteAction(split, root) as LayoutTreeSplitHorizontalAction).targetNodeId).toBe("b");
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

    it("lets the always and never settings decide, and the tab's manual choice win", () => {
        const root = rowOf(2);
        const { model, tabAtom } = makeModel(null, root);
        model.evaluate(root, boundsOf(1600));
        expect(model.active).toBe(false);
        setSetting("always");
        expect(model.active).toBe(true);
        setSetting("never");
        expect(model.active).toBe(false);
        globalStore.set(tabAtom, { oid: "tab-1", meta: { [View360MetaKey]: true } } as unknown as Tab);
        expect(model.active).toBe(true);
        expect(globalStore.get(model.decisionAtom).source).toBe("manual");
        model.toggle();
        expect(metaWrites()).toEqual([{ [View360MetaKey]: false }]);
        model.setManual(null);
        expect(metaWrites()[1]).toEqual({ [View360MetaKey]: null });
    });

    it("shows the pill in never mode while a column is too tight, until closed and a column is added", () => {
        setSetting("never");
        const { model } = makeModel(null, rowOf(3));
        model.evaluate(rowOf(3), boundsOf(1000));
        expect(model.active).toBe(false);
        expect(globalStore.get(model.pillAtom)).toBe(true);
        model.dismissPill();
        expect(globalStore.get(model.pillAtom)).toBe(false);
        model.evaluate(rowOf(3), boundsOf(900));
        expect(globalStore.get(model.pillAtom)).toBe(false);
        model.evaluate(rowOf(4), boundsOf(900));
        expect(globalStore.get(model.pillAtom)).toBe(true);
        model.setManual(true);
        expect(metaWrites()).toContainEqual({ [View360MetaKey]: true });
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
