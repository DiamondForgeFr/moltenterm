// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { findNode } from "@/layout/lib/layoutNode";
import { deleteNode } from "@/layout/lib/layoutTree";
import {
    FlexDirection,
    LayoutTreeActionType,
    type LayoutNode,
    type LayoutTreeDeleteNodeAction,
    type LayoutTreeState,
} from "@/layout/lib/types";
import { atom, createStore, type PrimitiveAtom } from "jotai";
import { describe, expect, it } from "vitest";
import { goneBlockIds, watchGoneBlockLeaves, type GoneBlockLayout } from "./gone-block-leaves";
import { clampScroll, computeCarpetLayout, visibleCarpetColumnIds, type CarpetLayout } from "./view360/carpet-model";

function leaf(id: string): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size: 10, data: { blockId: `b-${id}` } };
}

function tabWith(blockIds: string[]): Tab {
    return { oid: "tab-1", blockids: blockIds } as unknown as Tab;
}

// A layout over a real tree: the leaf is dropped by the layout's own delete.
function treeLayout(state: LayoutTreeState, dropped: string[] = []): GoneBlockLayout {
    const leafOf = (blockId: string, node: LayoutNode): LayoutNode => {
        if (node == null) {
            return null;
        }
        if (node.data?.blockId === blockId) {
            return node;
        }
        for (const child of node.children ?? []) {
            const found = leafOf(blockId, child);
            if (found != null) {
                return found;
            }
        }
        return null;
    };
    return {
        getNodeByBlockId: (blockId) => leafOf(blockId, state.rootNode),
        dropLeafNode: (nodeId) => {
            dropped.push(nodeId);
            deleteNode(state, { type: LayoutTreeActionType.DeleteNode, nodeId } as LayoutTreeDeleteNodeAction);
        },
    };
}

function carpetOf(root: LayoutNode): CarpetLayout {
    const [fixed, ...carpet] = root.children;
    return computeCarpetLayout({
        width: 1600,
        height: 900,
        fixedNodeId: fixed.id,
        fixedPx: 500,
        columns: carpet.map((c) => ({ nodeId: c.id, widthPx: 500 })),
    });
}

describe("goneBlockIds", () => {
    it("names the blocks that left the list", () => {
        expect(goneBlockIds(["a", "b", "c"], ["a", "c"])).toEqual(["b"]);
        expect(goneBlockIds(["a", "b"], [])).toEqual(["a", "b"]);
        expect(goneBlockIds(["a", "b"], null)).toEqual(["a", "b"]);
    });

    it("never names a block the list did not hold before", () => {
        expect(goneBlockIds([], ["a"])).toEqual([]);
        expect(goneBlockIds(null, ["a"])).toEqual([]);
        expect(goneBlockIds(["a"], ["a", "b"])).toEqual([]);
    });
});

describe("watchGoneBlockLeaves", () => {
    it("drops the leaf of a block deleted without the layout being told (#1739)", () => {
        const store = createStore();
        const tabAtom = atom(tabWith(["b-a", "b-b", "b-c"])) as PrimitiveAtom<Tab>;
        const state: LayoutTreeState = {
            rootNode: {
                id: "root",
                flexDirection: FlexDirection.Row,
                size: 10,
                children: [leaf("a"), leaf("b"), leaf("c")],
            },
        } as LayoutTreeState;
        const dropped: string[] = [];
        watchGoneBlockLeaves(store, tabAtom, treeLayout(state, dropped));

        store.set(tabAtom, tabWith(["b-a", "b-c"]));

        expect(dropped).toEqual(["b"]);
        expect(findNode(state.rootNode, "b")).toBeFalsy();
        expect(state.rootNode.children.map((c) => c.id)).toEqual(["a", "c"]);
    });

    it("leaves the layout alone when the leaf is already gone, or its block not yet in the tab", () => {
        const store = createStore();
        const tabAtom = atom(tabWith(["b-a"])) as PrimitiveAtom<Tab>;
        const state: LayoutTreeState = {
            rootNode: { id: "root", flexDirection: FlexDirection.Row, size: 10, children: [leaf("a"), leaf("new")] },
        } as LayoutTreeState;
        const dropped: string[] = [];
        watchGoneBlockLeaves(store, tabAtom, treeLayout(state, dropped));

        // The new panel's layout action came before the tab's update: its leaf stays.
        store.set(tabAtom, tabWith(["b-a"]));
        store.set(tabAtom, tabWith(["b-a", "b-new", "b-gone"]));
        // A block closed through the layout: its leaf went first.
        store.set(tabAtom, tabWith(["b-a", "b-new"]));

        expect(dropped).toEqual([]);
        expect(state.rootNode.children.map((c) => c.id)).toEqual(["a", "new"]);
    });

    it("ignores a tab not loaded yet, and stops when unsubscribed", () => {
        const store = createStore();
        const tabAtom = atom(tabWith(["b-a", "b-b"])) as PrimitiveAtom<Tab>;
        const dropped: string[] = [];
        const layout: GoneBlockLayout = {
            getNodeByBlockId: (blockId) => ({ id: blockId }),
            dropLeafNode: (nodeId) => dropped.push(nodeId),
        };
        const stop = watchGoneBlockLeaves(store, tabAtom, layout);
        store.set(tabAtom, null);
        expect(dropped).toEqual([]);
        store.set(tabAtom, tabWith(["b-a"]));
        expect(dropped).toEqual(["b-b"]);
        stop();
        store.set(tabAtom, tabWith([]));
        expect(dropped).toEqual(["b-b"]);
    });

    it("lets the 360 carpet reflow at once: the closed place is filled, nothing is left empty (#1739)", () => {
        const store = createStore();
        const ids = ["fixed", "c1", "c2", "c3", "c4"];
        const tabAtom = atom(tabWith(ids.map((id) => `b-${id}`))) as PrimitiveAtom<Tab>;
        const state: LayoutTreeState = {
            rootNode: { id: "root", flexDirection: FlexDirection.Row, size: 10, children: ids.map(leaf) },
        } as LayoutTreeState;
        watchGoneBlockLeaves(store, tabAtom, treeLayout(state));

        const before = carpetOf(state.rootNode);
        const scroll = before.maxScroll;
        const shownBefore = visibleCarpetColumnIds(before, scroll);
        expect(shownBefore).toContain("c4");

        // The last panel in view closes by itself (the sign-in terminal after a successful sign-in).
        store.set(tabAtom, tabWith(["b-fixed", "b-c1", "b-c2", "b-c3"]));

        const after = carpetOf(state.rootNode);
        expect(after.columns.map((c) => c.nodeId)).toEqual(["c1", "c2", "c3"]);
        const shownAfter = visibleCarpetColumnIds(after, clampScroll(after, scroll));
        expect(shownAfter).not.toContain("c4");
        expect(shownAfter.length).toBe(shownBefore.length);
    });
});
