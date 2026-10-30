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
import { GroupAll, GroupPages } from "./carpet-group";
import { GroupPinOrigin } from "./pin-model";
import {
    View360GroupMetaKey,
    View360MetaKey,
    View360PinsMetaKey,
    View360PlacesMetaKey,
} from "./view360-meta";
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
// Panels whose id starts with "p" are pages; "a" is the agent's terminal, the others are other panels.
vi.mock("../panel-size/panel-size-store", () => ({
    cachedBlockView: (blockId: string) => (blockId?.startsWith("b-p") ? "web" : blockId === "b-a" ? "term" : "other"),
    currentPanelSizes: () => ({}),
    currentFirstColumnFloorPx: () => null,
    clearFirstColumnFloor: vi.fn(),
    setFirstColumnFloor: vi.fn(),
    rememberPanelWidth: vi.fn(),
}));
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0));
vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));

const Wide = { top: 0, left: 0, width: 2400, height: 900 };
const Narrow = { top: 0, left: 0, width: 1200, height: 900 };

function leaf(id: string): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size: 10, data: { blockId: `b-${id}` } };
}

function rowOf(...ids: string[]): LayoutNode {
    return { id: "root", flexDirection: FlexDirection.Row, size: 10, children: ids.map(leaf) };
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
        getNodeByBlockId: (blockId: string) => findNode(rootNode, blockId.replace(/^b-/, "")),
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

function fixedIds(model: View360Model): string[] {
    return model.layout.fixedColumns.map((c) => `${c.nodeId}:${c.mode}`);
}

function carpetIds(model: View360Model): string[] {
    return model.layout.columns.map((c) => c.nodeId);
}

beforeEach(() => {
    vi.mocked(RpcApi.SetMetaCommand).mockClear();
    vi.mocked(showToast).mockClear();
});

describe("360 on the pages in the model (FR-SHELL-124)", () => {
    it("offers the choice only with two pages and another panel right of the agent (AC1)", () => {
        const offered = makeModel(rowOf("a", "p1", "int", "p2"));
        offered.pass();
        expect(offered.model.groupOffered()).toBe(true);
        const onePage = makeModel(rowOf("a", "p1", "int", "files"));
        onePage.pass();
        expect(onePage.model.groupOffered()).toBe(false);
        const pagesOnly = makeModel(rowOf("a", "p1", "p2", "p3"));
        pagesOnly.pass();
        expect(pagesOnly.model.groupOffered()).toBe(false);
        expect(pagesOnly.model.effectiveGroup()).toBe(GroupAll);
    });

    it("counts the numbers on the pages only (AC3)", () => {
        const { model, pass } = makeModel(rowOf("a", "p1", "int", "p2", "p3", "p4"));
        pass();
        expect(model.groupCarpetCount(GroupAll)).toBe(5);
        expect(model.groupCarpetCount(GroupPages)).toBe(4);
        expect(model.placeOptions(GroupPages).map((o) => o.stored)).toEqual([3, 2, 1]);
        const two = makeModel(rowOf("a", "p1", "int", "p2"));
        two.pass();
        expect(two.model.placeOptions(GroupAll).map((o) => o.offered)).toEqual([true, true, false]);
        expect(two.model.placeOptions(GroupPages).map((o) => o.offered)).toEqual([true, false, false]);
    });

    it("pins the other panels beside the agent on a wide window, marked, in one write with N (AC2, AC4)", () => {
        const { model, pass } = makeModel(rowOf("a", "p1", "int", "p2", "p3"));
        pass();
        expect(model.groupPlan()).toEqual([{ blockId: "b-int", mode: "beside" }]);
        expect(model.applyPlaces("b-p2", 1, GroupPages)).toBe(true);
        expect(metaWrites().at(-1)).toEqual({
            [View360PlacesMetaKey]: 1,
            [View360GroupMetaKey]: GroupPages,
            [View360PinsMetaKey]: { "b-int": { mode: "beside", by: GroupPinOrigin } },
        });
        pass();
        expect(fixedIds(model)).toEqual(["a:first", "int:beside"]);
        expect(carpetIds(model)).toEqual(["p1", "p2", "p3"]);
        expect(model.group()).toBe(GroupPages);
    });

    it("pins them under the agent when half of the window does not allow beside, never refusing (AC2)", () => {
        const { model, pass } = makeModel(rowOf("a", "p1", "int", "p2", "files"));
        pass(Narrow);
        expect(model.groupPlan().map((p) => p.mode)).toEqual(["stacked", "stacked"]);
        expect(model.applyPlaces("b-p1", 1, GroupPages)).toBe(true);
        pass(Narrow);
        expect(fixedIds(model)).toEqual(["a:first", "int:stacked", "files:stacked"]);
        expect(carpetIds(model)).toEqual(["p1", "p2"]);
        expect(vi.mocked(showToast).mock.calls.every((c) => c[0].id !== "view360-pin-refused")).toBe(true);
    });

    it("starts on the first page when the chooser was opened from a panel the grouping pins", () => {
        const { model, pass, layoutModel } = makeModel(rowOf("a", "int", "p1", "p2", "p3"));
        pass();
        expect(model.applyPlaces("b-int", 1, GroupPages)).toBe(true);
        pass();
        expect(carpetIds(model)).toEqual(["p1", "p2", "p3"]);
        expect(model.scrollLeft).toBe(0);
        expect(globalStore.get(layoutModel.focusedNode)?.id).toBe("int");
    });

    it("removes exactly the marked pins on returning to all panels, the developer's pin kept (AC4)", () => {
        const { model, pass } = makeModel(rowOf("a", "p1", "dev", "int", "p2", "p3"), {
            [View360PinsMetaKey]: { "b-dev": { mode: "stacked" } },
        });
        pass();
        model.applyPlaces("b-p1", 1, GroupPages);
        pass();
        expect(fixedIds(model)).toEqual(["a:first", "dev:stacked", "int:beside"]);
        expect(model.applyPlaces("b-p1", 2, GroupAll)).toBe(true);
        expect(globalStore.get(model.pinsAtom)).toEqual({ "b-dev": { mode: "stacked" } });
        expect(model.group()).toBe(GroupAll);
        pass();
        expect(carpetIds(model)).toEqual(["p1", "int", "p2", "p3"]);
    });

    it("removes exactly the marked pins on leaving, a pin placed by hand meanwhile kept (AC4)", () => {
        const { model, pass } = makeModel(rowOf("a", "p1", "int", "p2", "files", "p3"));
        pass();
        model.applyPlaces("b-p1", 1, GroupPages);
        pass();
        expect(model.pin("b-p3", "stacked")).toBe(true);
        pass();
        model.requestLeave();
        expect(globalStore.get(model.pinsAtom)).toEqual({ "b-p3": { mode: "stacked" } });
        expect(model.group()).toBe(GroupAll);
        expect(model.places()).toBeNull();
        expect(metaWrites().some((m) => m[View360GroupMetaKey] === null)).toBe(true);
    });

    it("lays a panel opened later on the carpet, pinned by nothing, and groups it on the next choice (AC5)", () => {
        const root = rowOf("a", "p1", "int", "p2");
        const { model, pass } = makeModel(root);
        pass();
        model.applyPlaces("b-p1", 1, GroupPages);
        pass();
        root.children.push(leaf("files"));
        pass();
        expect(carpetIds(model)).toEqual(["p1", "p2", "files"]);
        expect(Object.keys(globalStore.get(model.pinsAtom))).toEqual(["b-int"]);
        expect(model.effectiveGroup()).toBe(GroupPages);
        expect(model.applyPlaces("b-p1", 1)).toBe(true);
        pass();
        expect(carpetIds(model)).toEqual(["p1", "p2"]);
        expect(globalStore.get(model.pinsAtom)["b-files"]).toEqual({ mode: "beside", by: GroupPinOrigin });
    });

    it("undoes back to the pins and the grouping before (AC6)", () => {
        const { model, pass } = makeModel(rowOf("a", "p1", "int", "p2", "p3"), {
            [View360MetaKey]: true,
            [View360PinsMetaKey]: { "b-p3": { mode: "beside" } },
        });
        pass();
        model.applyPlaces("b-p1", 1, GroupPages);
        pass();
        expect(fixedIds(model)).toEqual(["a:first", "int:beside", "p3:beside"]);
        lastUndo()();
        expect(globalStore.get(model.pinsAtom)).toEqual({ "b-p3": { mode: "beside" } });
        expect(model.group()).toBe(GroupAll);
        expect(model.places()).toBeNull();
        pass();
        expect(fixedIds(model)).toEqual(["a:first", "p3:beside"]);

        model.applyPlaces("b-p1", 1, GroupPages);
        pass();
        model.applyPlaces("b-p1", 2, GroupAll);
        pass();
        lastUndo()();
        expect(model.group()).toBe(GroupPages);
        expect(model.places()).toBe(1);
        expect(globalStore.get(model.pinsAtom)["b-int"]).toEqual({ mode: "beside", by: GroupPinOrigin });
    });

    it("comes back grouped after a restart, with its marks and N (AC6)", () => {
        const { model, pass } = makeModel(rowOf("a", "p1", "int", "p2", "p3"), {
            [View360PlacesMetaKey]: 2,
            [View360GroupMetaKey]: GroupPages,
            [View360PinsMetaKey]: { "b-int": { mode: "beside", by: GroupPinOrigin } },
        });
        pass();
        expect(model.active).toBe(true);
        expect(model.group()).toBe(GroupPages);
        expect(fixedIds(model)).toEqual(["a:first", "int:beside"]);
        expect(globalStore.get(model.shownPlacesAtom)).toBe(2);
        model.requestLeave();
        expect(globalStore.get(model.pinsAtom)).toEqual({});
    });

    it("counts only the developer's pins in the chooser's pinned note", () => {
        const { model, pass } = makeModel(rowOf("a", "p1", "int", "p2", "dev"), {
            [View360PinsMetaKey]: { "b-dev": { mode: "stacked" } },
        });
        pass();
        model.applyPlaces("b-p1", 1, GroupPages);
        pass();
        expect(model.pinnedColumnCount()).toBe(1);
    });
});
