// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { findNode } from "@/layout/lib/layoutNode";
import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { atom, type PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { showToast } from "../toast-store";
import { carpetScrollStops } from "./carpet-model";
import { placesFixedPx } from "./carpet-places";
import { PlacesUndoMs } from "./carpet-places-toast";
import { View360MetaKey, View360PinsMetaKey, View360PlacesMetaKey } from "./view360-meta";
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
    return { ScreenModel: { getInstance: () => ({ thresholdAtom: screenThreshold.atom }) } };
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
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0));
vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));

const Wide = { top: 0, left: 0, width: 2400, height: 900 };

function leaf(id: string, size = 10): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size, data: { blockId: `b-${id}` } };
}

function rowOf(n: number, sizes?: number[]): LayoutNode {
    return {
        id: "root",
        flexDirection: FlexDirection.Row,
        size: 10,
        children: Array.from({ length: n }, (_, i) => leaf(`c${i}`, sizes?.[i] ?? 10)),
    };
}

function makeModel(rootNode: LayoutNode, meta: Record<string, unknown> = {}) {
    const tabAtom = atom({ oid: "tab-1", meta } as unknown as Tab) as PrimitiveAtom<Tab>;
    const focusedNode = atom(null as LayoutNode) as PrimitiveAtom<LayoutNode>;
    const layoutModel = {
        focusedNode,
        updateTree: vi.fn(),
        treeReducer: vi.fn(),
        treeState: { rootNode },
        displayContainerRef: { current: null },
        getNodeByBlockId: (blockId: string) => {
            const id = blockId.replace(/^b-/, "");
            return findNode(rootNode, id);
        },
        focusNode: vi.fn((id: string) => globalStore.set(focusedNode, findNode(rootNode, id))),
    } as unknown as LayoutModel;
    const model = new View360Model(layoutModel, tabAtom);
    const pass = (bounds = Wide) => {
        model.evaluate(rootNode, bounds);
        return model.computeLayout(rootNode, bounds);
    };
    return { model, tabAtom, layoutModel, pass };
}

function metaWrites(): Record<string, unknown>[] {
    return vi.mocked(RpcApi.SetMetaCommand).mock.calls.map((c) => c[1].meta as Record<string, unknown>);
}

function lastUndo(): () => void {
    const input = vi.mocked(showToast).mock.calls.at(-1)[0];
    return input.actions[0].run as () => void;
}

// The carpet columns wholly in view at the model's scroll position.
function wholeInView(model: View360Model): string[] {
    const layout = model.layout;
    const start = model.scrollLeft;
    const end = start + layout.viewport.width;
    return layout.columns.filter((c) => c.x >= start - 0.5 && c.x + c.width <= end + 0.5).map((c) => c.nodeId);
}

beforeEach(() => {
    vi.mocked(RpcApi.SetMetaCommand).mockClear();
    vi.mocked(showToast).mockClear();
});

describe("360 × N in the model (FR-SHELL-123)", () => {
    it("offers the numbers the view's columns and width allow", () => {
        const { model, pass } = makeModel(rowOf(3));
        pass();
        expect(model.placeOptions().map((o) => o.offered)).toEqual([true, false, false]);
        const wide = makeModel(rowOf(5));
        wide.pass();
        expect(wide.model.placeOptions().map((o) => o.offered)).toEqual([true, true, true]);
    });

    it("applies N with equal parts and the panel in the first place, the view keeping its N", () => {
        const { model, pass } = makeModel(rowOf(5));
        expect(pass()).toBeNull();
        expect(model.applyPlaces("b-c2", 2)).toBe(true);
        expect(model.active).toBe(true);
        expect(metaWrites().at(-1)).toEqual({ [View360PlacesMetaKey]: 2 });
        const layout = pass();
        const fixed = placesFixedPx(Wide.width, 2);
        expect(layout.fixed.width).toBe(fixed);
        const widths = layout.columns.map((c) => c.width);
        expect(new Set(widths).size).toBe(1);
        expect(Math.abs(widths[0] - fixed)).toBeLessThanOrEqual(1);
        expect(wholeInView(model)).toEqual(["c2", "c3"]);
        expect(globalStore.get(model.shownPlacesAtom)).toBe(2);
        expect(vi.mocked(showToast).mock.calls.at(-1)[0]).toMatchObject({ dismissMs: PlacesUndoMs, kind: "info" });
    });

    it("fills the places with the left neighbours from the last panel", () => {
        const { model, pass } = makeModel(rowOf(5));
        pass();
        model.applyPlaces("b-c4", 2);
        pass();
        expect(wholeInView(model)).toEqual(["c3", "c4"]);
        model.applyPlaces("b-c1", 3);
        pass();
        expect(wholeInView(model)).toEqual(["c1", "c2", "c3"]);
    });

    it("refuses a number that is not offered", () => {
        const { model, pass } = makeModel(rowOf(3));
        pass();
        expect(model.applyPlaces("b-c1", 2)).toBe(false);
        expect(model.places()).toBeNull();
    });

    it("shows fewer places while the window is too narrow, and N again once it widens", () => {
        const { model, pass } = makeModel(rowOf(5));
        pass();
        model.applyPlaces("b-c1", 2);
        pass();
        pass({ ...Wide, width: 1200 });
        expect(globalStore.get(model.shownPlacesAtom)).toBe(1);
        expect(model.places()).toBe(2);
        pass();
        expect(globalStore.get(model.shownPlacesAtom)).toBe(2);
    });

    it("comes back with its N after a restart, whatever the threshold", () => {
        const { model, pass } = makeModel(rowOf(4), { [View360PlacesMetaKey]: 2 });
        expect(model.places()).toBe(2);
        pass();
        expect(model.active).toBe(true);
        expect(globalStore.get(model.shownPlacesAtom)).toBe(2);
    });

    it("undoes back to the normal layout and the focus", async () => {
        const { model, pass, layoutModel } = makeModel(rowOf(5));
        pass();
        layoutModel.focusNode("c1");
        model.applyPlaces("b-c3", 1);
        pass();
        expect(globalStore.get(layoutModel.focusedNode)?.id).toBe("c3");
        lastUndo()();
        expect(model.active).toBe(false);
        expect(pass()).toBeNull();
        await vi.waitFor(() => expect(globalStore.get(layoutModel.focusedNode)?.id).toBe("c1"), { timeout: 30000 });
        expect(metaWrites().at(-1)).toEqual({ [View360PlacesMetaKey]: null });
    });

    it("undoes back to the N, pins, fixed zone width and scroll before", () => {
        const pins = { "b-c1": { mode: "beside" } };
        const { model, pass, tabAtom } = makeModel(rowOf(6), {
            [View360MetaKey]: true,
            [View360PinsMetaKey]: pins,
        });
        pass();
        model.grippedFixedPx = 700;
        model.scrollTo(200);
        const scrollBefore = model.scrollLeft;
        model.applyPlaces("b-c4", 1);
        expect(model.grippedFixedPx).toBeNull();
        pass();
        // Another window unpinned meanwhile: Undo writes the pins back.
        globalStore.set(tabAtom, { oid: "tab-1", meta: { [View360MetaKey]: true, [View360PlacesMetaKey]: 1 } } as unknown as Tab);
        lastUndo()();
        expect(model.grippedFixedPx).toBe(700);
        expect(globalStore.get(model.pinsAtom)).toEqual(pins);
        expect(model.places()).toBeNull();
        pass();
        expect(model.scrollLeft).toBe(scrollBefore);
    });

    it("forgets N on leaving, the columns taking back the developer's proportions", () => {
        const root = rowOf(4, [40, 20, 20, 20]);
        const { model, pass, layoutModel } = makeModel(root);
        pass();
        model.applyPlaces("b-c1", 1);
        pass();
        root.children.forEach((c) => (c.size = 25));
        model.requestLeave();
        expect(model.places()).toBeNull();
        expect(metaWrites().some((m) => m[View360PlacesMetaKey] === null)).toBe(true);
        expect(pass()).toBeNull();
        expect(root.children.map((c) => Math.round(c.size))).toEqual([40, 20, 20, 20]);
        expect(layoutModel.treeReducer).not.toHaveBeenCalledWith(undefined);
    });

    it("stays in 360 × N once panels close until nothing is hidden", () => {
        const root = rowOf(4);
        const { model, pass } = makeModel(root);
        pass();
        model.applyPlaces("b-c1", 1);
        pass();
        root.children.splice(2, 2);
        pass();
        expect(model.active).toBe(true);
        expect(model.places()).toBe(1);
    });

    it("moves the carpet by whole panels on a wheel gesture", async () => {
        const { model, pass } = makeModel(rowOf(6));
        pass();
        model.applyPlaces("b-c1", 1);
        const layout = pass();
        expect(model.scrollLeft).toBe(0);
        model.scrollBy(5);
        expect(model.scrollLeft).toBe(0);
        model.scrollBy(30);
        const stops = carpetScrollStops(layout);
        await vi.waitFor(() => expect(model.scrollLeft).toBe(stops[1]), { timeout: 30000 });
    });

    it("tells where the header button stands, in the normal layout too", () => {
        const { model, pass } = makeModel(rowOf(3), { [View360PinsMetaKey]: { "b-c2": { mode: "stacked" } } });
        pass();
        expect(globalStore.get(model.rolesAtom)).toEqual({ "b-c0": "first", "b-c1": "carpet", "b-c2": "stacked" });
    });
});
