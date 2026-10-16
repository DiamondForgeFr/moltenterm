// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { FlexDirection, LayoutTreeActionType, type LayoutNode } from "@/layout/lib/types";
import { atom, type PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { showToast } from "../toast-store";
import { EqualizeAutoMetaKey, EqualizeModel, treeShape } from "./equalize-model";

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(() => Promise.resolve()) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("../toast-store", () => ({ showToast: vi.fn() }));
vi.mock("../panel-size/panel-size-store", () => ({
    cachedBlockView: () => "term",
    currentPanelSizes: () => ({}),
    rememberPanelWidth: vi.fn(),
}));

function leaf(id: string, size = 10): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size, data: { blockId: `b-${id}` } };
}

function makeModel(auto: boolean, rootNode: LayoutNode) {
    const tabAtom = atom({
        oid: "tab-1",
        meta: auto ? { [EqualizeAutoMetaKey]: true } : {},
    } as unknown as Tab) as PrimitiveAtom<Tab>;
    const view360 = {
        layout: null as unknown,
        layoutAtom: atom(null),
        dragFixedPx: null,
        dragColumn: null,
        dragPin: null,
    };
    const layoutModel = {
        treeState: { rootNode },
        treeReducer: vi.fn(),
        updateTree: vi.fn(),
        leafOrder: atom([]),
        moltenView360: view360,
    } as unknown as LayoutModel;
    return { model: new EqualizeModel(layoutModel, tabAtom), layoutModel, tabAtom, view360 };
}

function sizes(node: LayoutNode): number[] {
    return node.children.map((c) => Math.round(c.size * 100) / 100);
}

describe("EqualizeModel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("equalizes once through the layout's reducer", () => {
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("a", 60), leaf("b", 40)],
        };
        const { model, layoutModel } = makeModel(false, root);
        model.equalize();
        expect(layoutModel.treeReducer).toHaveBeenCalledWith({
            type: LayoutTreeActionType.ResizeNode,
            resizeOperations: [
                { nodeId: "a", size: 50 },
                { nodeId: "b", size: 50 },
            ],
        });
    });

    it("with auto on, evens out a new shape before it is drawn, and leaves a resize of the same shape alone", () => {
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("a"), leaf("b")],
        };
        const { model, layoutModel } = makeModel(true, root);
        model.beforeUpdate();
        root.children.push(leaf("c", 5));
        model.beforeUpdate();
        const after = layoutModel.treeState.rootNode;
        expect(sizes(after)).toEqual([33.33, 33.33, 33.33]);
        after.children[0].size = 70;
        model.beforeUpdate();
        expect(after.children[0].size).toBe(70);
    });

    it("with auto off, never touches the tree", () => {
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("a", 70), leaf("b", 30)],
        };
        const { model } = makeModel(false, root);
        model.beforeUpdate();
        expect(sizes(root)).toEqual([70, 30]);
    });

    it("turns auto off with a one-line notice when a divider is dragged by hand", () => {
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("a"), leaf("b")],
        };
        const { model } = makeModel(true, root);
        model.onResizeEnd(false);
        expect(model.auto).toBe(true);
        model.onResizeEnd(true);
        expect(model.auto).toBe(false);
        expect(showToast).toHaveBeenCalledWith(
            expect.objectContaining({ title: "Auto equalize off: you adjusted a panel by hand" })
        );
        expect(vi.mocked(RpcApi.SetMetaCommand).mock.calls.at(-1)[1].meta).toEqual({ [EqualizeAutoMetaKey]: null });
    });

    it("counts a 360 column drag as a drag by hand", () => {
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("a"), leaf("b")],
        };
        const { model, view360 } = makeModel(true, root);
        view360.dragColumn = { nodeId: "b", kind: "term", px: 500 };
        model.onResizeEnd(false);
        expect(model.auto).toBe(false);
    });

    it("keeps the auto mode in the tab's meta and equalizes when it is turned on", () => {
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("a", 80), leaf("b", 20)],
        };
        const { model, layoutModel, tabAtom } = makeModel(false, root);
        model.setAuto(true);
        expect(model.auto).toBe(true);
        expect(vi.mocked(RpcApi.SetMetaCommand).mock.calls[0][1].meta).toEqual({ [EqualizeAutoMetaKey]: true });
        expect(layoutModel.treeReducer).toHaveBeenCalled();
        // The meta catches up: it is the truth again.
        globalStore.set(tabAtom, { oid: "tab-1", meta: { [EqualizeAutoMetaKey]: true } } as unknown as Tab);
        expect(globalStore.get(model.pendingAutoAtom)).toBeNull();
        expect(model.auto).toBe(true);
    });

    it("describes the tree's shape without its sizes", () => {
        const a: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("a", 1), leaf("b", 2)],
        };
        const b: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("a", 5), leaf("b", 9)],
        };
        expect(treeShape(a)).toBe(treeShape(b));
        b.children.reverse();
        expect(treeShape(a)).not.toBe(treeShape(b));
    });
});
