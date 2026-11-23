// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A saved layout never keeps a panel at size 0 (#2497): the rule, and the layout model that applies it when it loads.

import { globalStore } from "@/app/store/jotaiStore";
import { LayoutModel } from "@/layout/lib/layoutModel";
import { DefaultNodeSize, FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { atom, type PrimitiveAtom } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { repairZeroSizes } from "./zero-size-repair";

const layoutState = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { getSettingsKeyAtom: () => atom("auto"), WOS: { makeORef: () => "", getObjectValue: () => null } };
});
vi.mock("@/app/store/focusManager", () => ({ FocusManager: { getInstance: () => ({ requestNodeFocus: vi.fn() }) } }));
vi.mock("@/app/store/services", () => ({ BlockService: { CleanupOrphanedBlocks: vi.fn() } }));
vi.mock("@/app/store/wos", () => ({
    makeORef: (type: string, id: string) => `${type}:${id}`,
    loadAndPinWaveObject: vi.fn(() => Promise.resolve(null)),
    getObjectValue: vi.fn(() => null),
    reloadWaveObject: vi.fn(() => Promise.resolve(null)),
    setObjectValue: vi.fn(),
}));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(() => Promise.resolve()) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/layout/lib/layoutAtom", () => ({ getLayoutStateAtomFromTab: () => layoutState.current }));
vi.mock("../toast-store", () => ({ showToast: vi.fn(() => "toast:1") }));
vi.mock("../panel-motion/panel-arrival-model", () => ({ notePanelsArrived: vi.fn() }));
vi.mock("../view360/screen-store", async () => {
    const { atom } = await import("jotai");
    const { makeFakeScreens } = await import("../view360/screen-store-fake");
    return { ScreenModel: { getInstance: () => makeFakeScreens(atom(8)) } };
});

function leaf(id: string, size: number): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size, data: { blockId: `b-${id}` } };
}

function group(id: string, dir: FlexDirection, children: LayoutNode[], size = 100): LayoutNode {
    return { id, flexDirection: dir, size, children };
}

// The "Kimi" view of the developer's gold (#2497): the agent's terminal at 100, its companion at 0.
function goldKimiView(): LayoutNode {
    return group("root", FlexDirection.Row, [leaf("agent", 100), leaf("companion", 0)], 10);
}

describe("repairZeroSizes (#2497)", () => {
    it("gives a panel at size 0 the average share of its siblings: the gold's companion gets half the width", () => {
        const root = goldKimiView();
        expect(repairZeroSizes(root)).toBe(true);
        expect(root.children.map((c) => c.size)).toEqual([100, 100]);
    });

    it("repairs deep in the tree, and a size that is no number", () => {
        const stack = group("stack", FlexDirection.Column, [leaf("s1", 30), leaf("s2", NaN), leaf("s3", 60)], 0);
        const root = group("root", FlexDirection.Row, [leaf("a", 50), stack]);
        expect(repairZeroSizes(root)).toBe(true);
        expect(stack.size).toBe(50);
        expect(stack.children.map((c) => c.size)).toEqual([30, 45, 60]);
    });

    it("gives siblings that are all at 0 the default size", () => {
        const root = group("root", FlexDirection.Row, [leaf("a", 0), leaf("b", -3)]);
        expect(repairZeroSizes(root)).toBe(true);
        expect(root.children.map((c) => c.size)).toEqual([DefaultNodeSize, DefaultNodeSize]);
    });

    it("leaves a sound layout, a lone panel and an empty tab as they are", () => {
        const root = group("root", FlexDirection.Row, [leaf("a", 70), leaf("b", 30)]);
        expect(repairZeroSizes(root)).toBe(false);
        expect(root.children.map((c) => c.size)).toEqual([70, 30]);
        expect(repairZeroSizes(leaf("a", 0))).toBe(false);
        expect(repairZeroSizes(null)).toBe(false);
    });
});

describe("the layout repairs a saved panel at size 0 when it loads (#2497)", () => {
    it("the gold's Kimi view loads with its companion visible", () => {
        layoutState.current = atom({ oid: "layout-1", rootnode: goldKimiView(), pendingbackendactions: [] });
        const tabAtom = atom({ oid: "tab-1", layoutstate: "layout-1", meta: {} } as unknown as Tab) as PrimitiveAtom<Tab>;
        const model = new LayoutModel(tabAtom, globalStore.get, globalStore.set);
        const sizes = model.treeState.rootNode.children.map((c) => c.size);
        expect(sizes.every((s) => s > 0)).toBe(true);
        expect(sizes[0]).toBe(sizes[1]);
    });
});
