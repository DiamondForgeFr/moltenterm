// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
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
import { describe, expect, it, vi } from "vitest";
import { View360MetaKey } from "./view360-meta";
import { View360Model } from "./view360-model";

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

function makeModel(on: boolean, rootNode: LayoutNode) {
    const tabAtom = atom({
        oid: "tab-1",
        meta: on ? { [View360MetaKey]: true } : {},
    } as unknown as Tab) as PrimitiveAtom<Tab>;
    const layoutModel = {
        focusedNode: atom(null as LayoutNode),
        updateTree: vi.fn(),
        treeState: { rootNode },
        displayContainerRef: { current: null },
    } as unknown as LayoutModel;
    return { model: new View360Model(layoutModel, tabAtom), tabAtom, layoutModel };
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
        expect(off.computeLayout(root, bounds)).toBeNull();
        const { model } = makeModel(true, root);
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

    it("re-runs the layout when the tab enters or leaves 360 view", () => {
        const root = leaf("only");
        const { tabAtom, layoutModel } = makeModel(false, root);
        globalStore.set(tabAtom, { oid: "tab-1", meta: { [View360MetaKey]: true } } as unknown as Tab);
        expect(layoutModel.updateTree).toHaveBeenCalled();
    });
});
