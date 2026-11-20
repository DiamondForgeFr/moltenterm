// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A panel opened from a link in a 360 × N that holds exactly N pages (#2439): the tab is drawn as the grid until the
// panel makes it store one, so the add switches it to the 360 view. The panel must stay in view and keep the focus once
// the layout has settled, as it does when the 360 already stores pages. These tests drive the real LayoutModel through
// the path the companion's links take (openInBrowserPanel → createBesideFocused → openPanelBeside → addPanelColumn).

import { globalStore } from "@/app/store/jotaiStore";
import { LayoutModel } from "@/layout/lib/layoutModel";
import { findNode } from "@/layout/lib/layoutNode";
import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { atom, type PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPanelBeside } from "../split/add-beside";
import { visibleCarpetColumnIds } from "./carpet-model";
import { View360MetaKey, View360PlacesMetaKey } from "./view360-meta";

const env = vi.hoisted(() => ({
    layout: null as unknown,
    settingAtom: null as unknown,
    // The block each giveFocus call handed the keyboard to, in order.
    keyboard: [] as string[],
}));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    env.settingAtom = atom<string>("auto");
    const { globalStore } = await import("@/app/store/jotaiStore");
    const layout = () => env.layout as LayoutModel;
    return {
        globalStore,
        getSettingsKeyAtom: () => env.settingAtom,
        WOS: { makeORef: () => "", getObjectValue: () => null, getWaveObjectAtom: () => atom(null) },
        getFocusedBlockId: () => globalStore.get(layout().focusedNode)?.data?.blockId ?? null,
        // A panel given the keyboard takes the layout's focus, as Wave's block focus handler does.
        getBlockComponentModel: (blockId: string) => ({
            viewModel: {
                giveFocus: () => {
                    env.keyboard.push(blockId);
                    const node = layout().getNodeByBlockId(blockId);
                    if (node != null) {
                        layout().focusNode(node.id);
                    }
                    return true;
                },
            },
        }),
    };
});
vi.mock("@/layout/lib/layoutModelHooks", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/layout/lib/layoutModelHooks")>()),
    getLayoutModelForStaticTab: () => env.layout,
}));
vi.mock("@/app/store/focusManager", () => ({ FocusManager: { getInstance: () => ({ requestNodeFocus: vi.fn() }) } }));
vi.mock("@/app/store/services", () => ({
    BlockService: { CleanupOrphanedBlocks: vi.fn() },
    ObjectService: { CreateBlock: vi.fn(() => Promise.resolve("b-page")), DeleteBlock: vi.fn() },
}));
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
vi.mock("./screen-store", async () => {
    const { atom } = await import("jotai");
    const { makeFakeScreens } = await import("./screen-store-fake");
    const threshold = atom(8);
    return { ScreenModel: { getInstance: () => makeFakeScreens(threshold) } };
});

const Wide = 3600;
const PageDef = { meta: { view: "molten-browser", url: "https://example.com/milestone/1" } } as BlockDef;

function leaf(id: string, size: number): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size, data: { blockId: `b-${id}` } };
}

// An agent (c0) in the fixed zone and exactly n pages c1..cn in a 360 × n, `focused` in focus and holding the keyboard.
function fullLayout(n: number, focused: string): LayoutModel {
    const ids = Array.from({ length: n + 1 }, (_, i) => `c${i}`);
    const root: LayoutNode = {
        id: "root",
        flexDirection: FlexDirection.Row,
        size: 100,
        children: ids.map((id) => leaf(id, 100 / ids.length)),
    };
    const meta = { [View360MetaKey]: true, [View360PlacesMetaKey]: n };
    const tabAtom = atom({ oid: "tab-1", layoutstate: "layout-1", meta } as unknown as Tab) as PrimitiveAtom<Tab>;
    const model = new LayoutModel(tabAtom, globalStore.get, globalStore.set);
    model.treeState = { rootNode: root, focusedNodeId: focused } as typeof model.treeState;
    globalStore.set(model["localTreeStateAtom"], { ...model.treeState });
    model.displayContainerRef = {
        current: {
            getBoundingClientRect: () => ({ left: 0, top: 0, width: Wide, height: 900 }),
            contains: () => true,
        },
    } as never;
    model.updateTree();
    env.layout = model;
    return model;
}

function inView(model: LayoutModel): string[] {
    return visibleCarpetColumnIds(model.moltenView360.layout, model.moltenView360.scrollLeft);
}

// Every timer and frame the add started has run, and the layout drew again on the way, as React would.
function settle(model: LayoutModel) {
    for (let i = 0; i < 40; i++) {
        vi.advanceTimersByTime(50);
        model.updateTree();
    }
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    vi.stubGlobal("document", { activeElement: {}, getElementById: () => null });
    env.keyboard = [];
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("a panel opened from a link in a 360 × N holding exactly N pages lands on it and stays (#2439)", () => {
    for (const n of [1, 2, 3]) {
        const from = ["c0", ...Array.from({ length: n }, (_, i) => `c${i + 1}`)];
        for (const focused of from) {
            const where = focused === "c0" ? "the fixed zone" : `page ${focused.slice(1)}`;
            it(`360 × ${n}, link clicked in ${where}`, async () => {
                const model = fullLayout(n, focused);
                expect(model.moltenView360.layout).toBeNull();
                expect(model.moltenView360.addMode()).toBe("zones");
                expect(await openPanelBeside(`b-${focused}`, PageDef)).toBe("b-page");
                settle(model);
                const page = model.getNodeByBlockId("b-page");
                expect(page).toBeDefined();
                expect(globalStore.get(model.moltenView360.shownPlacesAtom)).toBe(n);
                expect(inView(model)).toContain(page.id);
                expect(globalStore.get(model.focusedNode)?.id).toBe(page.id);
                expect(env.keyboard.filter((blockId) => blockId !== "b-page")).toEqual([]);
                expect(findNode(model.treeState.rootNode, focused)).toBeDefined();
            });
        }
    }

    it("a second link, once the 360 stores a page, lands on its panel too", async () => {
        const model = fullLayout(2, "c2");
        await openPanelBeside("b-c2", PageDef);
        settle(model);
        vi.mocked((await import("@/app/store/services")).ObjectService.CreateBlock).mockResolvedValueOnce("b-page2");
        await openPanelBeside("b-page", PageDef);
        settle(model);
        const second = model.getNodeByBlockId("b-page2");
        expect(inView(model)).toContain(second.id);
        expect(globalStore.get(model.focusedNode)?.id).toBe(second.id);
    });
});
