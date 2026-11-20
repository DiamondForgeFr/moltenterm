// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The entry points that build their own action (FR-SHELL-042, FR-SHELL-123 AC17, #2433), run for real on a real layout
// model: splits, "+" and "Add a panel on the left / right", a call to action opening a panel, a panel dropped from
// another tab, a panel dragged inside the tab. Each ends in LayoutModel.treeReducer, where one rule applies
// (add-panel.test.ts holds the rule). The others (createBlock*, ⌘T, the palette, a page, a file or a tab opened as a
// panel, an agent's panels, a reopened panel) send the same actions, which that file runs.

import { globalStore } from "@/app/store/jotaiStore";
import { LayoutModel } from "@/layout/lib/layoutModel";
import { findNode } from "@/layout/lib/layoutNode";
import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { atom, type PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { visibleCarpetColumnIds } from "../view360/carpet-model";
import { View360MetaKey, View360PlacesMetaKey } from "../view360/view360-meta";

const current = vi.hoisted(() => ({ model: null as unknown, created: 0 }));
const settingAtom = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    settingAtom.current = atom<string>("auto");
    return {
        getSettingsKeyAtom: () => settingAtom.current,
        getFocusedBlockId: () => null,
        WOS: { makeORef: () => "", getObjectValue: () => null, getWaveObjectAtom: () => atom(null) },
    };
});
vi.mock("@/layout/index", async () => {
    const types = await import("@/layout/lib/types");
    const nodes = await import("@/layout/lib/layoutNode");
    return {
        LayoutTreeActionType: types.LayoutTreeActionType,
        newLayoutNode: nodes.newLayoutNode,
        getLayoutModelForStaticTab: () => current.model,
    };
});
vi.mock("@/app/store/services", () => ({
    BlockService: { CleanupOrphanedBlocks: vi.fn() },
    ObjectService: { CreateBlock: vi.fn(async () => `b-new${++current.created}`), DeleteBlock: vi.fn() },
}));
vi.mock("@/app/store/focusManager", () => ({ FocusManager: { getInstance: () => ({ requestNodeFocus: vi.fn() }) } }));
vi.mock("@/app/store/wos", () => ({
    makeORef: (type: string, id: string) => `${type}:${id}`,
    loadAndPinWaveObject: vi.fn(() => Promise.resolve(null)),
    getObjectValue: vi.fn(() => null),
    reloadWaveObject: vi.fn(() => Promise.resolve(null)),
    setObjectValue: vi.fn(),
}));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(() => Promise.resolve()) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/layout/lib/layoutAtom", async () => {
    const { atom } = await import("jotai");
    return { getLayoutStateAtomFromTab: () => atom({ pendingbackendactions: [] }) };
});
vi.mock("../toast-store", () => ({ showToast: vi.fn(() => "toast:1") }));
vi.mock("../panel-motion/panel-arrival-model", () => ({ notePanelsArrived: vi.fn() }));
vi.mock("../panel-size/panel-size-store", () => ({
    cachedBlockView: () => "web",
    currentPanelSizes: () => ({}),
    currentFirstColumnFloorPx: () => null,
    clearFirstColumnFloor: vi.fn(),
    setFirstColumnFloor: vi.fn(),
    rememberPanelWidth: vi.fn(),
    applyRememberedPanelSizes: vi.fn(),
    recordDraggedPanelSizes: vi.fn(),
    addedBlockId: (action: { node?: LayoutNode; newNode?: LayoutNode }) =>
        action?.node?.data?.blockId ?? action?.newNode?.data?.blockId ?? null,
}));
vi.mock("../view360/screen-store", async () => {
    const { atom } = await import("jotai");
    const { makeFakeScreens } = await import("../view360/screen-store-fake");
    const threshold = atom(8);
    return { ScreenModel: { getInstance: () => makeFakeScreens(threshold) } };
});
vi.mock("../split/drop-zones", () => ({ hitTestPanels: vi.fn() }));
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0));
vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));

import { insertBlockAtZone, movePanel } from "../split/panel-move";
import { addPanelColumn, addPickerColumn, insertBlockBeside, splitPanel } from "../split/split";

function leaf(id: string, size = 25): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size, data: { blockId: `b-${id}` } };
}

function row(...ids: string[]): LayoutNode {
    return {
        id: "root",
        flexDirection: FlexDirection.Row,
        size: 100,
        children: ids.map((id) => leaf(id, 100 / ids.length)),
    };
}

function makeLayout(root: LayoutNode, meta: Record<string, unknown> = {}, focusedId: string = null, width = 4000) {
    const tabAtom = atom({ oid: "tab-1", layoutstate: "layout-1", meta } as unknown as Tab) as PrimitiveAtom<Tab>;
    const model = new LayoutModel(tabAtom, globalStore.get, globalStore.set);
    model.treeState = { rootNode: root, focusedNodeId: focusedId } as typeof model.treeState;
    globalStore.set(model["localTreeStateAtom"], { ...model.treeState });
    model.displayContainerRef = {
        current: { getBoundingClientRect: () => ({ left: 0, top: 0, width, height: 900 }) },
    } as never;
    model.updateTree();
    current.model = model;
    return model;
}

function expectEven(parent: LayoutNode) {
    for (const child of parent.children) {
        expect(child.size).toBeCloseTo(100 / parent.children.length, 5);
    }
}

const ids = (parent: LayoutNode) => parent.children.map((c) => c.id);

beforeEach(() => {
    current.created = 0;
});

describe("outside the 360 view", () => {
    it("a split to the right (the menus, the header's split, Cmd+D): the row shares its width", async () => {
        const model = makeLayout(row("a", "b", "c"));
        const blockId = await splitPanel("b-b", "right");
        expect(blockId).toBe("b-new1");
        const root = model.treeState.rootNode;
        expect(root.children.length).toBe(4);
        expect(root.children[2].data.blockId).toBe("b-new1");
        expectEven(root);
    });

    it("a split to the left: the row shares its width", async () => {
        const model = makeLayout(row("a", "b"));
        await splitPanel("b-a", "left");
        const root = model.treeState.rootNode;
        expect(root.children[0].data.blockId).toBe("b-new1");
        expectEven(root);
    });

    it("a split below a panel: the column shares its heights", async () => {
        const model = makeLayout(row("a", "b"));
        await splitPanel("b-a", "down");
        const column = model.treeState.rootNode.children[0];
        expect(column.children.length).toBe(2);
        expectEven(column);
        expect(model.treeState.rootNode.children.map((c) => c.size)).toEqual([50, 50]);
    });

    it("a panel laid beside another (a panel dropped from another tab, a tab dropped on a panel)", () => {
        const model = makeLayout(row("a", "b", "c"));
        expect(insertBlockBeside("b-a", "right", "b-from-other-tab")).toBe(true);
        expectEven(model.treeState.rootNode);
        expect(model.treeState.rootNode.children.length).toBe(4);
    });

    it("a panel dropped on the edge of a panel", () => {
        const model = makeLayout(row("a", "b", "c"));
        expect(insertBlockAtZone("b-b", "left", "b-x")).toBe(true);
        const root = model.treeState.rootNode;
        expect(root.children[1].data.blockId).toBe("b-x");
        expectEven(root);
    });

    it("Add a panel on the right, a '+' (a picker column): the row shares its width", async () => {
        const model = makeLayout(row("a", "b"));
        const id = await addPickerColumn(model, "b-a", () => ({ targetNodeId: "a", position: "after" }));
        expect(id).toBe("b-new1");
        expect(ids(model.treeState.rootNode).length).toBe(3);
        expectEven(model.treeState.rootNode);
    });

    it("a panel a call to action opens (a column with the panel itself)", async () => {
        const model = makeLayout(row("a", "b"));
        await addPanelColumn(model, { meta: { view: "web" } } as BlockDef, () => ({
            targetNodeId: "b",
            position: "after",
        }));
        expect(model.treeState.rootNode.children.length).toBe(3);
        expectEven(model.treeState.rootNode);
    });

    it("a panel dragged inside the tab (a drop on an edge): the row it joins shares its width", () => {
        const model = makeLayout(row("a", "b", "c"));
        expect(movePanel(model, "c", "a", "left")).toBe(true);
        const root = model.treeState.rootNode;
        expect(ids(root)).toEqual(["c", "a", "b"]);
        expectEven(root);
    });

    it("a panel dragged onto the stack of another: the column shares its heights", () => {
        const model = makeLayout(row("a", "b", "c"));
        expect(movePanel(model, "c", "a", "down")).toBe(true);
        const root = model.treeState.rootNode;
        expect(root.children.length).toBe(2);
        expect(ids(root.children[0])).toEqual(["a", "c"]);
        expectEven(root.children[0]);
        expect(root.children[0].size).toBeCloseTo(root.children[1].size, 5);
    });
});

describe("under a 360 × N the entry points keep the zones (FR-SHELL-123 AC17)", () => {
    const meta = (places: number) => ({ [View360MetaKey]: true, [View360PlacesMetaKey]: places });
    const inView = (model: LayoutModel) =>
        visibleCarpetColumnIds(model.moltenView360.layout, model.moltenView360.scrollLeft);
    const rootOrder = (model: LayoutModel) => model.treeState.rootNode.children.map((c) => c.id);

    it("a split to the right of the first zone's panel: next to it, the panel on the right goes to the carpet", async () => {
        const model = makeLayout(row("c0", "c1", "c2", "c3", "c4", "c5"), meta(2), "c1");
        await splitPanel("b-c1", "right");
        model.updateTree();
        expect(rootOrder(model).length).toBe(7);
        expect(rootOrder(model).slice(0, 2)).toEqual(["c0", "c1"]);
        expect(inView(model)).toEqual(["c1", model.treeState.rootNode.children[2].id]);
        expect(globalStore.get(model.moltenView360.shownPlacesAtom)).toBe(2);
    });

    it("a split below stays inside its column: no zone is added", async () => {
        const model = makeLayout(row("c0", "c1", "c2", "c3", "c4", "c5"), meta(2), "c1");
        await splitPanel("b-c1", "down");
        model.updateTree();
        const root = model.treeState.rootNode;
        expect(root.children.length).toBe(6);
        expect(root.children[1].children.map((c) => c.data.blockId)).toEqual(["b-c1", "b-new1"]);
        expect(inView(model)).toEqual([root.children[1].id, "c2"]);
    });

    it("Add a panel on the right of the last zone: the carpet moves a zone, both stay in view", async () => {
        const model = makeLayout(row("c0", "c1", "c2", "c3", "c4", "c5"), meta(2), "c2");
        await addPickerColumn(model, "b-c2", () => ({ targetNodeId: "c2", position: "after" }));
        model.updateTree();
        expect(rootOrder(model).slice(0, 4)).toEqual(["c0", "c1", "c2", model.treeState.rootNode.children[3].id]);
        expect(inView(model)).toEqual(["c2", model.treeState.rootNode.children[3].id]);
    });

    it("a panel dropped on the edge of a visible panel (from another tab): next to it, the zones keep their number", () => {
        const model = makeLayout(row("c0", "c1", "c2", "c3", "c4", "c5"), meta(3), "c1", 5000);
        expect(insertBlockAtZone("b-c1", "right", "b-x")).toBe(true);
        model.updateTree();
        const added = findNode(model.treeState.rootNode, "c1");
        expect(added).toBeDefined();
        expect(inView(model).length).toBe(3);
        expect(inView(model)[0]).toBe("c1");
        expect(model.treeState.rootNode.children.map((c) => c.data?.blockId).slice(0, 3)).toEqual([
            "b-c0",
            "b-c1",
            "b-x",
        ]);
    });
});
