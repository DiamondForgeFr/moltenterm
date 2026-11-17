// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { findNode } from "@/layout/lib/layoutNode";
import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { atom, type PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAgentPagePanel } from "./carpet-agent-page";
import { carpetScrollStops, scrollToRevealColumn } from "./carpet-model";
import { bringPanelIntoView } from "./carpet-reveal";
import { View360MetaKey } from "./view360-meta";
import { View360Model } from "./view360-model";

const settingAtom = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    settingAtom.current = atom<string>("auto");
    return { getSettingsKeyAtom: () => settingAtom.current };
});
const screenThreshold = vi.hoisted(() => ({ atom: null as unknown }));
vi.mock("./screen-store", async () => {
    const { atom } = await import("jotai");
    screenThreshold.atom = atom(8);
    const { makeFakeScreens } = await import("./screen-store-fake");
    return { ScreenModel: { getInstance: () => makeFakeScreens(screenThreshold.atom) } };
});
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(() => Promise.resolve()) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("../toast-store", () => ({ showToast: vi.fn(() => "toast:1") }));
vi.mock("../panel-size/panel-size-store", () => ({
    cachedBlockView: () => "web",
    currentPanelSizes: () => ({}),
    currentFirstColumnFloorPx: () => null,
    clearFirstColumnFloor: vi.fn(),
    setFirstColumnFloor: vi.fn(),
    rememberPanelWidth: vi.fn(),
}));
vi.mock("./carpet-agent-page", () => ({ isAgentPagePanel: vi.fn() }));
const shownLayout = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/layout/lib/layoutModelHooks", () => ({ getLayoutModelForStaticTab: () => shownLayout.current }));
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0));
vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));

const Wide = { top: 0, left: 0, width: 2400, height: 900 };

function leaf(id: string): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size: 10, data: { blockId: `b-${id}` } };
}

function rowOf(n: number): LayoutNode {
    return {
        id: "root",
        flexDirection: FlexDirection.Row,
        size: 10,
        children: Array.from({ length: n }, (_, i) => leaf(`c${i}`)),
    };
}

function makeModel(rootNode: LayoutNode, on = true) {
    const tabAtom = atom({ oid: "tab-1", meta: { [View360MetaKey]: on } } as unknown as Tab) as PrimitiveAtom<Tab>;
    const focusedNode = atom(null as LayoutNode) as PrimitiveAtom<LayoutNode>;
    const layoutModel = {
        focusedNode,
        updateTree: vi.fn(),
        treeReducer: vi.fn(),
        treeState: { rootNode },
        displayContainerRef: { current: null },
        getNodeByBlockId: (blockId: string) => findNode(rootNode, blockId.replace(/^b-/, "")),
        focusNode: vi.fn((id: string) => globalStore.set(focusedNode, findNode(rootNode, id))),
    } as unknown as LayoutModel;
    const model = new View360Model(layoutModel, tabAtom);
    const pass = () => {
        model.evaluate(rootNode, Wide);
        return model.computeLayout(rootNode, Wide);
    };
    return { model, layoutModel, focusedNode, pass };
}

// The agent's tool and a page it opened last: asked after the layout placed the new block.
function resolvesTo(isAgentPage: boolean) {
    const promise = Promise.resolve(isAgentPage);
    vi.mocked(isAgentPagePanel).mockReturnValue(promise);
    return promise;
}

beforeEach(() => {
    vi.mocked(isAgentPagePanel).mockReset();
});

describe("a panel added to the carpet (#1812)", () => {
    it("scrolls to any panel added in 360 view, an agent's page included", () => {
        const { model, pass } = makeModel(rowOf(6));
        pass();
        expect(model.active).toBe(true);
        const reveal = vi.spyOn(model, "revealBlock");
        model.onBlocksAdded(["b-c5"]);
        expect(reveal).toHaveBeenCalledWith("b-c5");
        expect(isAgentPagePanel).not.toHaveBeenCalled();
    });

    it("changes nothing in a grid view, for a panel in view or for a panel of another view", () => {
        const grid = makeModel(rowOf(2), false);
        grid.pass();
        expect(grid.model.active).toBe(false);
        grid.model.revealBlock("b-c1");
        expect(grid.model.scrollLeft).toBe(0);
        const { model, pass } = makeModel(rowOf(3));
        pass();
        const inView = pass().columns[1];
        model.revealBlock("b-c1");
        expect(model.scrollLeft).toBe(0);
        expect(inView.x + inView.width).toBeLessThanOrEqual(model.layout.viewport.width);
        model.revealBlock("b-elsewhere");
        expect(model.scrollLeft).toBe(0);
    });

    describe("under a 360 × N", () => {
        function underN() {
            const rig = makeModel(rowOf(6));
            rig.pass();
            expect(rig.model.applyPlaces("b-c1", 2)).toBe(true);
            rig.pass();
            expect(globalStore.get(rig.model.shownPlacesAtom)).toBe(2);
            return rig;
        }

        it("brings the page an agent opened in front of the developer, without taking the focus", async () => {
            const { model, layoutModel, focusedNode } = underN();
            globalStore.set(focusedNode, findNode(layoutModel.treeState.rootNode, "c1"));
            const reveal = vi.spyOn(model, "revealBlock");
            const asked = resolvesTo(true);
            model.onBlocksAdded(["b-c5"]);
            await asked;
            await vi.waitFor(() => expect(reveal).toHaveBeenCalledWith("b-c5"));
            expect(layoutModel.focusNode).not.toHaveBeenCalledWith("c5");
            expect(globalStore.get(focusedNode)?.id).toBe("c1");
        });

        it("advances the carpet by whole places until the page is in view", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
            try {
                const { model, layoutModel, focusedNode, pass } = underN();
                globalStore.set(focusedNode, findNode(layoutModel.treeState.rootNode, "c1"));
                const layout = pass();
                const column = layout.columns.find((c) => c.nodeId === "c5");
                const before = model.scrollLeft;
                expect(before + layout.viewport.width).toBeLessThan(column.x + column.width);
                const asked = resolvesTo(true);
                model.onBlocksAdded(["b-c5"]);
                await asked;
                await vi.advanceTimersByTimeAsync(1000);
                const after = model.scrollLeft;
                expect(after).toBeGreaterThan(before);
                expect(after).toBe(scrollToRevealColumn(layout, "c5", before));
                expect(carpetScrollStops(layout)).toContain(after);
                expect(after + layout.viewport.width).toBeGreaterThanOrEqual(column.x + column.width - 1);
                expect(globalStore.get(focusedNode)?.id).toBe("c1");
            } finally {
                vi.useRealTimers();
            }
        });

        it("leaves any other panel opened without the focus on the carpet, as FR-SHELL-123 AC11 says", async () => {
            const { model } = underN();
            const reveal = vi.spyOn(model, "revealBlock");
            const asked = resolvesTo(false);
            model.onBlocksAdded(["b-c5"]);
            await asked;
            await Promise.resolve();
            expect(isAgentPagePanel).toHaveBeenCalledWith("b-c5");
            expect(reveal).not.toHaveBeenCalled();
        });

        it("shows a panel that took the focus without asking what it is", () => {
            const { model, layoutModel, focusedNode } = underN();
            globalStore.set(focusedNode, findNode(layoutModel.treeState.rootNode, "c5"));
            const reveal = vi.spyOn(model, "revealBlock");
            model.onBlocksAdded(["b-c5"]);
            expect(reveal).toHaveBeenCalledWith("b-c5");
            expect(isAgentPagePanel).not.toHaveBeenCalled();
        });
    });
});

// #1994: the page the agent already had and shows again (tabs_show) goes through the layout of the shown tab.
describe("a page the agent shows again (#1994)", () => {
    function shownBy(rig: ReturnType<typeof makeModel>, magnified?: string) {
        const shown = Object.assign(rig.layoutModel, {
            moltenView360: rig.model,
            magnifiedNodeId: magnified,
            magnifyNodeToggle: vi.fn(),
        });
        shownLayout.current = shown;
        return shown;
    }

    afterEach(() => {
        shownLayout.current = null;
        vi.useRealTimers();
    });

    it("scrolls the carpet to the page's column, on the same stops as a page opened, keeping the focus", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        const rig = makeModel(rowOf(6));
        rig.pass();
        globalStore.set(rig.focusedNode, findNode(rig.layoutModel.treeState.rootNode, "c0"));
        const layout = rig.pass();
        const column = layout.columns.find((c) => c.nodeId === "c5");
        const before = rig.model.scrollLeft;
        expect(before + layout.viewport.width).toBeLessThan(column.x + column.width);
        const shown = shownBy(rig);
        bringPanelIntoView("b-c5");
        await vi.advanceTimersByTimeAsync(1000);
        const after = rig.model.scrollLeft;
        expect(after).toBe(scrollToRevealColumn(layout, "c5", before));
        expect(after + layout.viewport.width).toBeGreaterThanOrEqual(column.x + column.width - 1);
        expect(shown.magnifyNodeToggle).not.toHaveBeenCalled();
        expect(shown.focusNode).not.toHaveBeenCalled();
        expect(globalStore.get(rig.focusedNode)?.id).toBe("c0");
    });

    it("leaves the carpet where it is when the page is already in view", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        const rig = makeModel(rowOf(3));
        rig.pass();
        shownBy(rig);
        bringPanelIntoView("b-c1");
        await vi.advanceTimersByTimeAsync(1000);
        expect(rig.model.scrollLeft).toBe(0);
    });

    it("in a grid view ends the magnification hiding the page and scrolls nothing", async () => {
        const rig = makeModel(rowOf(3), false);
        rig.pass();
        expect(rig.model.active).toBe(false);
        const shown = shownBy(rig, "c0");
        bringPanelIntoView("b-c2");
        expect(shown.magnifyNodeToggle).toHaveBeenCalledWith("c0");
        expect(shown.focusNode).not.toHaveBeenCalled();
        expect(rig.model.scrollLeft).toBe(0);
    });
});
