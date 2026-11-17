// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { findNode } from "@/layout/lib/layoutNode";
import {
    FlexDirection,
    LayoutTreeActionType,
    type LayoutNode,
    type LayoutTreeInsertNodeAction,
    type LayoutTreeSplitHorizontalAction,
} from "@/layout/lib/types";
import { atom, type PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { showToast } from "../toast-store";
import { canPinBeside, carpetScrollStops, defaultCarpetWidthPx } from "./carpet-model";
import { besideZonePx, placesFit, placesFixedPx } from "./carpet-places";
import { PlacesToastId, PlacesUndoMs } from "./carpet-places-toast";
import { ResizeSettleMs } from "./view360-decision";
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
    const { makeFakeScreens } = await import("./screen-store-fake");
    return { ScreenModel: { getInstance: () => makeFakeScreens(screenThreshold.atom) } };
});
function setScreenThreshold(n: number) {
    globalStore.set(screenThreshold.atom as PrimitiveAtom<number>, n);
}
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

    it("says the places that fit after a pin, and that they come back with the pin gone (#1500)", () => {
        const pinned = besideZonePx([defaultCarpetWidthPx("web")]);
        let width = 1300;
        while (
            !(
                placesFit(width, 2) &&
                !placesFit(width, 2, 0, pinned) &&
                placesFit(width, 1, 0, pinned) &&
                canPinBeside(width, 0)
            )
        ) {
            width += 10;
        }
        const bounds = { ...Wide, width };
        const { model, pass } = makeModel(rowOf(5));
        pass(bounds);
        model.applyPlaces("b-c1", 2);
        pass(bounds);
        expect(globalStore.get(model.shownPlacesAtom)).toBe(2);
        vi.mocked(showToast).mockClear();

        expect(model.pin("b-c3", "beside")).toBe(true);
        pass(bounds);
        pass(bounds);
        expect(model.places()).toBe(2);
        expect(globalStore.get(model.shownPlacesAtom)).toBe(1);
        expect(showToast).toHaveBeenCalledTimes(1);
        expect(vi.mocked(showToast).mock.calls[0][0]).toMatchObject({
            id: PlacesToastId,
            title: "1 panel visible on the right",
            message: "The pin takes the last place. It comes back when you unpin.",
        });
        expect(model.placeOptions().map((o) => o.offered)).toEqual([true, false, false]);

        vi.mocked(showToast).mockClear();
        expect(model.unpin("b-c3")).toBe(true);
        pass(bounds);
        pass(bounds);
        expect(globalStore.get(model.shownPlacesAtom)).toBe(2);
        expect(showToast).toHaveBeenCalledTimes(1);
        expect(vi.mocked(showToast).mock.calls[0][0]).toMatchObject({
            id: PlacesToastId,
            title: "2 panels visible on the right",
            message: "1 place is back, as the pin is gone.",
        });
    });

    it("says nothing when a pin leaves the places as they were", () => {
        const { model, pass } = makeModel(rowOf(5));
        pass();
        model.applyPlaces("b-c1", 2);
        pass();
        vi.mocked(showToast).mockClear();
        expect(model.pin("b-c3", "beside")).toBe(true);
        pass();
        pass();
        expect(globalStore.get(model.shownPlacesAtom)).toBe(2);
        expect(showToast).not.toHaveBeenCalled();
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
        globalStore.set(tabAtom, {
            oid: "tab-1",
            meta: { [View360MetaKey]: true, [View360PlacesMetaKey]: 1 },
        } as unknown as Tab);
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

    it("stays in 360 × N while something is stored, however many panels close", () => {
        const root = rowOf(5);
        const { model, pass } = makeModel(root);
        pass();
        model.applyPlaces("b-c1", 1);
        pass();
        root.children.splice(3, 1);
        expect(pass()).not.toBeNull();
        expect(model.active).toBe(true);
        expect(model.places()).toBe(1);
    });
});

describe("a 360 × N that stores nothing rests in the grid (#2175, FR-SHELL-123-AC15)", () => {
    // Four columns and a 360 × 1: closing two of them leaves the first column and one carpet panel, every panel visible.
    function restingView() {
        const root = rowOf(4);
        const view = makeModel(root);
        view.pass();
        view.model.applyPlaces("b-c1", 1);
        view.pass();
        expect(view.model.active).toBe(true);
        vi.mocked(showToast).mockClear();
        vi.mocked(RpcApi.SetMetaCommand).mockClear();
        const signal = globalStore.get(view.model.signalAtom);
        root.children.splice(2, 2);
        return { ...view, root, signal };
    }

    it("draws the grid once every panel is visible, keeping the N", () => {
        const { model, pass } = restingView();
        expect(pass()).toBeNull();
        expect(model.active).toBe(false);
        expect(model.places()).toBe(1);
        expect(model.wanted).toBe(true);
        expect(globalStore.get(model.shownPlacesAtom)).toBeNull();
        expect(globalStore.get(model.decisionAtom)).toMatchObject({ active: false, source: "manual", idle: true });
        expect(metaWrites().some((m) => View360PlacesMetaKey in m)).toBe(false);
    });

    it("gives the developer's proportions back, as any other way out of 360 view does", () => {
        const root = rowOf(4, [40, 20, 20, 20]);
        const { model, pass } = makeModel(root);
        pass();
        model.applyPlaces("b-c1", 1);
        pass();
        root.children.splice(2, 2);
        root.children.forEach((c) => (c.size = 10));
        expect(pass()).toBeNull();
        expect(model.active).toBe(false);
        expect(root.children.map((c) => Math.round(c.size))).toEqual([67, 33]);
    });

    it("brings the 360 view back with the same N when a panel opens, with no notice and no glow", () => {
        const { model, pass, root, signal } = restingView();
        pass();
        root.children.push(leaf("c9"));
        const layout = pass();
        expect(layout).not.toBeNull();
        expect(model.active).toBe(true);
        expect(model.places()).toBe(1);
        expect(globalStore.get(model.shownPlacesAtom)).toBe(1);
        expect(layout.columns.map((c) => c.nodeId)).toEqual(["c1", "c9"]);
        expect(showToast).not.toHaveBeenCalled();
        expect(globalStore.get(model.signalAtom)).toBe(signal);
        expect(globalStore.get(model.decisionAtom).source).toBe("manual");
    });

    it("says nothing when the view goes to the grid and back", () => {
        const { pass, root, signal, model } = restingView();
        pass();
        root.children.push(leaf("c9"));
        pass();
        root.children.pop();
        pass();
        expect(model.active).toBe(false);
        expect(showToast).not.toHaveBeenCalled();
        expect(globalStore.get(model.signalAtom)).toBe(signal);
    });

    it("lays a panel opened while the grid rests at the end of the carpet, which brings the 360 view back", () => {
        const { model, pass, root } = restingView();
        pass();
        const node = leaf("c9");
        const rewritten = model.rewriteAction(
            {
                type: LayoutTreeActionType.InsertNode,
                node,
                magnified: false,
                focused: true,
            } as LayoutTreeInsertNodeAction,
            root
        ) as LayoutTreeSplitHorizontalAction;
        expect([rewritten.targetNodeId, rewritten.position]).toEqual(["c1", "after"]);
    });

    it("rests for a view put in 360 view by hand as well", () => {
        const { model, pass } = makeModel(rowOf(2), { [View360MetaKey]: true, [View360PlacesMetaKey]: 1 });
        expect(pass()).toBeNull();
        expect(model.active).toBe(false);
        expect(model.places()).toBe(1);
    });

    it("rests after a restart too, whatever the threshold", () => {
        setScreenThreshold(2);
        const { model, pass } = makeModel(rowOf(3), { [View360PlacesMetaKey]: 2 });
        expect(pass()).toBeNull();
        expect(model.active).toBe(false);
        expect(model.places()).toBe(2);
        setScreenThreshold(8);
    });

    it("keeps the 360 view when the panels do not fit side by side at their readable minimums", () => {
        vi.useFakeTimers();
        try {
            const root = rowOf(4);
            const { model, pass } = makeModel(root);
            pass();
            model.applyPlaces("b-c1", 2);
            pass();
            root.children.splice(3, 1);
            expect(pass({ ...Wide, width: 1100 })).not.toBeNull();
            expect(model.active).toBe(true);
            expect(model.places()).toBe(2);
            expect(globalStore.get(model.decisionAtom).idle).toBeUndefined();
            // Wide again: the automatic rule leaves only once the width has held, then the view rests.
            pass();
            expect(model.active).toBe(true);
            vi.advanceTimersByTime(ResizeSettleMs);
            expect(pass()).toBeNull();
            expect(model.active).toBe(false);
            expect(model.places()).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("counts the carpet without the pinned columns: a pin that leaves nothing stored lets the view rest", () => {
        const root = rowOf(4);
        const { model, pass } = makeModel(root);
        pass();
        model.applyPlaces("b-c1", 1);
        pass();
        root.children.splice(3, 1);
        expect(pass()).not.toBeNull();
        expect(globalStore.get(model.carpetColumnCountAtom)).toBe(2);
        expect(model.pin("b-c2", "beside")).toBe(true);
        expect(pass()).toBeNull();
        expect(globalStore.get(model.carpetColumnCountAtom)).toBe(1);
        expect(model.active).toBe(false);
        expect(model.places()).toBe(1);
        root.children.push(leaf("c9"));
        expect(pass()).not.toBeNull();
        expect(model.active).toBe(true);
    });

    it("turns the plain 360 view on from the button, forgetting the N that kept the grid", () => {
        const { model, pass, tabAtom } = restingView();
        pass();
        model.setActive(true);
        expect(model.places()).toBeNull();
        expect(metaWrites().some((m) => m[View360PlacesMetaKey] === null)).toBe(true);
        expect(metaWrites().some((m) => m[View360MetaKey] === true)).toBe(true);
        // The tab's meta caught up with the button's write.
        globalStore.set(tabAtom, { oid: "tab-1", meta: { [View360MetaKey]: true } } as unknown as Tab);
        expect(pass()).not.toBeNull();
        expect(model.active).toBe(true);
    });

    it("leaves the N alone when the button is clicked on a view that stores something", () => {
        const root = rowOf(5);
        const { model, pass } = makeModel(root);
        pass();
        model.applyPlaces("b-c1", 1);
        pass();
        model.setActive(true);
        expect(model.places()).toBe(1);
    });
});

describe("360 × N in the model: the carpet's steps and the header button (FR-SHELL-123)", () => {
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

describe("closing a panel under a 360 × N (FR-SHELL-126-AC3)", () => {
    // Seven carpet columns c1…c7 and two places: the places in view, then the pass after the close.
    async function closed(startBlock: string, closeBlock: string, closeColumn: string) {
        const root = rowOf(8);
        const { model, pass } = makeModel(root);
        pass();
        model.applyPlaces(startBlock, 2);
        pass();
        const before = wholeInView(model);
        await vi.waitFor(() => expect(globalStore.get(model.visibleColumnIdsAtom)).toEqual(before), { timeout: 30000 });
        model.planClose(closeBlock);
        root.children.splice(
            root.children.findIndex((c) => c.id === closeColumn),
            1
        );
        pass();
        return { before, after: wholeInView(model) };
    }

    it("the next stored panel to the right takes the place of a visible one that closes", async () => {
        const { before, after } = await closed("b-c3", "b-c3", "c3");
        expect(before).toEqual(["c3", "c4"]);
        expect(after).toEqual(["c4", "c5"]);
        const second = await closed("b-c3", "b-c4", "c4");
        expect(second.after).toEqual(["c3", "c5"]);
    });

    it("at the start of the carpet", async () => {
        const { before, after } = await closed("b-c1", "b-c1", "c1");
        expect(before).toEqual(["c1", "c2"]);
        expect(after).toEqual(["c2", "c3"]);
    });

    it("at the end of the carpet the stored panel to the left comes in", async () => {
        const { before, after } = await closed("b-c7", "b-c7", "c7");
        expect(before).toEqual(["c6", "c7"]);
        expect(after).toEqual(["c5", "c6"]);
    });

    it("keeps the same places in view when a stored panel to their left closes", async () => {
        const { before, after } = await closed("b-c4", "b-c1", "c1");
        expect(before).toEqual(["c4", "c5"]);
        expect(after).toEqual(["c4", "c5"]);
    });

    it("plans nothing for a panel of the fixed zone, or without a 360 × N", () => {
        const { model, pass } = makeModel(rowOf(5));
        pass();
        model.planClose("b-c1");
        expect(model.pendingStart).toBeNull();
        model.applyPlaces("b-c2", 2);
        pass();
        model.pendingStart = null;
        model.planClose("b-c0");
        expect(model.pendingStart).toBeNull();
    });
});
