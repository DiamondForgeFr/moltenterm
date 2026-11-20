// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The zones of a 360 × N (FR-SHELL-123 AC17 to AC21, #2433): resizing trades width between two neighbours, the
// shares are remembered, a panel added keeps the zone count, and "Even out the zones".

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { findNode } from "@/layout/lib/layoutNode";
import { FlexDirection, type LayoutNode, type ResizeHandleProps } from "@/layout/lib/types";
import { atom, type PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { showToast } from "../toast-store";
import { visibleCarpetColumnIds } from "./carpet-model";
import { PlacesUndoMs, ZonesToastId } from "./carpet-places-toast";
import { MinZonePx } from "./carpet-zones";
import { View360PlacesMetaKey, View360ZonesMetaKey } from "./view360-meta";
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

function makeModel(rootNode: LayoutNode, meta: Record<string, unknown> = {}, width = Wide.width) {
    const tabAtom = atom({ oid: "tab-1", meta } as unknown as Tab) as PrimitiveAtom<Tab>;
    const focusedNode = atom(null as LayoutNode) as PrimitiveAtom<LayoutNode>;
    const layoutModel = {
        focusedNode,
        updateTree: vi.fn(),
        treeReducer: vi.fn(),
        treeState: { rootNode },
        displayContainerRef: { current: { getBoundingClientRect: () => ({ left: 0, width }) } },
        setter: vi.fn(),
        pendingTreeAction: { throttledValueAtom: null },
        getNodeByBlockId: (blockId: string) => findNode(rootNode, blockId.replace(/^b-/, "")),
        focusNode: vi.fn((id: string) => globalStore.set(focusedNode, findNode(rootNode, id))),
    } as unknown as LayoutModel;
    const model = new View360Model(layoutModel, tabAtom);
    const pass = (bounds = { ...Wide, width }) => {
        model.evaluate(rootNode, bounds);
        return model.computeLayout(rootNode, bounds);
    };
    return { model, tabAtom, layoutModel, pass, rootNode };
}

function metaWrites(): Record<string, unknown>[] {
    return vi.mocked(RpcApi.SetMetaCommand).mock.calls.map((c) => c[1].meta as Record<string, unknown>);
}

function inView(model: View360Model): string[] {
    return visibleCarpetColumnIds(model.layout, model.scrollLeft);
}

// The handle on the right edge of the carpet column at `index`, as the layout draws it.
function handleOf(model: View360Model, rootNode: LayoutNode, index: number): ResizeHandleProps {
    return model.rootResizeHandles(rootNode, 10, []).find((h) => h.parentIndex === index + 1);
}

function dragBorder(model: View360Model, rootNode: LayoutNode, index: number, toPx: number) {
    const handle = handleOf(model, rootNode, index);
    expect(handle).toBeDefined();
    model.onResizeMove(handle, toPx);
    model.onResizeEnd();
}

beforeEach(() => {
    vi.mocked(RpcApi.SetMetaCommand).mockClear();
    vi.mocked(showToast).mockClear();
});

describe("the reported case (#2433)", () => {
    it("keeps two zones that fill the band when the middle one is shrunk in a 360 × 2", () => {
        const { model, pass, rootNode } = makeModel(rowOf(5), { [View360PlacesMetaKey]: 2 });
        const before = pass();
        expect(inView(model)).toEqual(["c1", "c2"]);
        const band = before.viewport.width;
        // The border between the two zones, dragged 200 px to the left: the middle zone shrinks.
        const border = before.viewport.left + before.columns[0].width;
        dragBorder(model, rootNode, 0, border - 200);
        const after = pass();
        expect(inView(model)).toEqual(["c1", "c2"]);
        const widths = after.columns.slice(0, 2).map((c) => c.width);
        expect(widths[0]).toBeLessThan(before.columns[0].width);
        expect(widths[0] + widths[1]).toBeGreaterThanOrEqual(Math.floor(band) - 1);
        expect(widths[0] + widths[1]).toBeLessThanOrEqual(band);
        expect(globalStore.get(model.shownPlacesAtom)).toBe(2);
    });
});

const sum = (values: number[]) => values.reduce((acc, v) => acc + v, 0);

function zoneWidths(model: View360Model, from = 0, count = 3): number[] {
    return model.layout.columns.slice(from, from + count).map((c) => c.width);
}

function lastUndo(): () => void {
    return vi.mocked(showToast).mock.calls.at(-1)[0].actions[0].run as () => void;
}

describe("a border dragged in a 360 × 3 (FR-SHELL-123 AC18)", () => {
    it("trades width between its two neighbours only and the zones keep filling the band", () => {
        const { model, pass, rootNode } = makeModel(rowOf(7), { [View360PlacesMetaKey]: 3 }, 3600);
        const before = pass();
        const [a, b, c] = zoneWidths(model);
        dragBorder(model, rootNode, 0, before.viewport.left + a + 100);
        const after = pass();
        const [a2, b2, c2] = zoneWidths(model);
        expect(a2).toBe(a + 100);
        expect(b2).toBe(b - 100);
        expect(c2).toBe(c);
        expect(inView(model)).toEqual(["c1", "c2", "c3"]);
        expect(a2 + b2 + c2).toBeGreaterThanOrEqual(Math.floor(after.viewport.width) - 1);
        expect(globalStore.get(model.shownPlacesAtom)).toBe(3);
    });

    it("the second border trades between the middle and the last zone", () => {
        const { model, pass, rootNode } = makeModel(rowOf(7), { [View360PlacesMetaKey]: 3 }, 3600);
        const before = pass();
        const [a, b, c] = zoneWidths(model);
        dragBorder(model, rootNode, 1, before.viewport.left + a + b - 150);
        pass();
        const [a2, b2, c2] = zoneWidths(model);
        expect(a2).toBe(a);
        expect(b2).toBe(b - 150);
        expect(c2).toBe(c + 150);
    });

    it("stops at the minimum width instead of pushing a zone out", () => {
        const { model, pass, rootNode } = makeModel(rowOf(7), { [View360PlacesMetaKey]: 3 }, 3600);
        const before = pass();
        dragBorder(model, rootNode, 0, before.viewport.left - 2000);
        pass();
        expect(zoneWidths(model)[0]).toBe(MinZonePx);
        dragBorder(model, rootNode, 0, before.viewport.left + 5000);
        pass();
        const widths = zoneWidths(model);
        expect(widths[1]).toBe(MinZonePx);
        expect(inView(model)).toEqual(["c1", "c2", "c3"]);
    });

    it("draws a border only between two zones in view: none at the band's edges", () => {
        for (const [n, expected] of [
            [1, [0]],
            [2, [0, 1]],
            [3, [0, 1, 2]],
        ] as const) {
            const { model, pass, rootNode } = makeModel(rowOf(7), { [View360PlacesMetaKey]: n }, 3600);
            pass();
            expect(model.rootResizeHandles(rootNode, 10, []).map((h) => h.parentIndex)).toEqual(expected);
        }
    });

    it("ignores a border that is not between two zones in view, so no zone is added and no gap opens", () => {
        const { model, pass, rootNode } = makeModel(rowOf(7), { [View360PlacesMetaKey]: 2 }, 3600);
        const before = pass();
        const widths = zoneWidths(model);
        const stray = { id: `${rootNode.id}-2`, parentNodeId: rootNode.id, parentIndex: 2 } as ResizeHandleProps;
        model.onResizeMove(stray, before.viewport.left + widths[0] + widths[1] - 300);
        expect(model.dragZones).toBeNull();
        expect(model.onResizeEnd()).toBe(false);
        pass();
        expect(zoneWidths(model, 0, 2)).toEqual(widths.slice(0, 2));
    });

    it("never lets a drag set the width of a column by itself", () => {
        const { model, pass, rootNode } = makeModel(rowOf(7), { [View360PlacesMetaKey]: 2 }, 3600);
        const before = pass();
        dragBorder(model, rootNode, 0, before.viewport.left + 100);
        expect(model.dragColumn).toBeNull();
        expect(model.carpetPx.size).toBe(0);
    });
});

describe("the zones' shares are remembered (FR-SHELL-123 AC19)", () => {
    it("writes the shares of the view and its configuration to the tab's meta", () => {
        const { model, pass, rootNode } = makeModel(rowOf(7), { [View360PlacesMetaKey]: 2 }, 3600);
        const before = pass();
        const [a, b] = zoneWidths(model, 0, 2);
        dragBorder(model, rootNode, 0, before.viewport.left + a - 200);
        const written = metaWrites().find((m) => View360ZonesMetaKey in m)[View360ZonesMetaKey] as Record<
            string,
            number[]
        >;
        expect(Object.keys(written)).toEqual(["2"]);
        expect(sum(written["2"])).toBeCloseTo(1, 6);
        expect(written["2"][0]).toBeCloseTo((a - 200) / (a + b), 2);
    });

    it("comes back after a restart, whatever the window", () => {
        const meta = { [View360PlacesMetaKey]: 2, [View360ZonesMetaKey]: { "2": [0.3, 0.7] } };
        for (const width of [3000, 3600, 4400]) {
            const { model, pass } = makeModel(rowOf(7), meta, width);
            const layout = pass();
            const [a, b] = zoneWidths(model, 0, 2);
            expect(a / (a + b)).toBeCloseTo(0.3, 2);
            expect(a + b).toBeGreaterThanOrEqual(Math.floor(layout.viewport.width) - 1);
        }
    });

    it("keeps the shares when the window is resized", () => {
        const { model, pass } = makeModel(
            rowOf(7),
            { [View360PlacesMetaKey]: 2, [View360ZonesMetaKey]: { "2": [0.4, 0.6] } },
            3600
        );
        pass();
        const wide = zoneWidths(model, 0, 2);
        pass({ ...Wide, width: 3000 });
        const narrow = zoneWidths(model, 0, 2);
        expect(narrow[0]).toBeLessThan(wide[0]);
        expect(narrow[0] / sum(narrow)).toBeCloseTo(wide[0] / sum(wide), 2);
    });

    it("keeps the shares of each number of zones apart", () => {
        const meta = { [View360PlacesMetaKey]: 3, [View360ZonesMetaKey]: { "2": [0.3, 0.7] } };
        const { model, pass } = makeModel(rowOf(7), meta, 3600);
        pass();
        const widths = zoneWidths(model);
        expect(new Set(widths).size).toBe(1);
    });

    it("gives each panel that comes into view the width of the zone it lands in", async () => {
        const meta = { [View360PlacesMetaKey]: 2, [View360ZonesMetaKey]: { "2": [0.3, 0.7] } };
        const { model, pass, layoutModel } = makeModel(rowOf(7), meta, 3600);
        layoutModel.updateTree = vi.fn(() => void pass());
        const layout = pass();
        const band = layout.viewport.width;
        expect(inView(model)).toEqual(["c1", "c2"]);
        expect(layout.columns[0].width / band).toBeCloseTo(0.3, 2);
        model.scrollTo(layout.columns[1].x);
        await vi.waitFor(() => expect(model.restColumnId).toBe("c2"), { timeout: 30000 });
        expect(inView(model)).toEqual(["c2", "c3"]);
        expect(model.layout.columns[1].width / band).toBeCloseTo(0.3, 2);
        expect(model.layout.columns[2].width / band).toBeCloseTo(0.7, 2);
        expect(model.scrollLeft).toBe(model.layout.columns[1].x);
    });

    it("draws the border between the two zones in view once the carpet moved, the zones being equal", async () => {
        const { model, pass, layoutModel, rootNode } = makeModel(rowOf(7), { [View360PlacesMetaKey]: 2 }, 3600);
        layoutModel.updateTree = vi.fn(() => void pass());
        const layout = pass();
        expect(model.rootResizeHandles(rootNode, 10, []).map((h) => h.parentIndex)).toEqual([0, 1]);
        model.scrollTo(layout.columns[1].x);
        await vi.waitFor(() => expect(model.restColumnId).toBe("c2"), { timeout: 30000 });
        expect(inView(model)).toEqual(["c2", "c3"]);
        expect(model.layoutPage).toBe(1);
        // The grip, then the border between c2 and c3: none at the band's left edge, where c1 is stored.
        expect(model.rootResizeHandles(rootNode, 10, []).map((h) => h.parentIndex)).toEqual([0, 2]);
    });

    it("trades width between the two zones in view with that border once the carpet moved", async () => {
        const { model, pass, layoutModel, rootNode } = makeModel(rowOf(7), { [View360PlacesMetaKey]: 2 }, 3600);
        layoutModel.updateTree = vi.fn(() => void pass());
        const layout = pass();
        model.scrollTo(layout.columns[1].x);
        await vi.waitFor(() => expect(model.restColumnId).toBe("c2"), { timeout: 30000 });
        const [a] = zoneWidths(model, 1, 2);
        const left = model.layout.viewport.left;
        dragBorder(model, rootNode, 1, left + a + 150);
        pass();
        // The shares are kept to four digits: a pixel of rounding, and the two zones fill the band.
        const [first, second] = zoneWidths(model, 1, 2);
        expect(Math.abs(first - (a + 150))).toBeLessThanOrEqual(1);
        expect(first + second).toBe(Math.floor(model.layout.viewport.width));
        expect(inView(model)).toEqual(["c2", "c3"]);
    });

    it("does not lay the zones again while the carpet is dragged, and once when it is let go", () => {
        vi.useFakeTimers();
        try {
            const meta = { [View360PlacesMetaKey]: 2, [View360ZonesMetaKey]: { "2": [0.3, 0.7] } };
            const { model, pass, layoutModel } = makeModel(rowOf(7), meta, 3600);
            layoutModel.updateTree = vi.fn(() => void pass());
            const layout = pass();
            const band = layout.viewport.width;
            const wide = layout.columns[1].width;
            expect(wide / band).toBeCloseTo(0.7, 2);
            // The strip's drag moves the scroll in the geometry it started from.
            model.scrollTo(layout.columns[1].x);
            vi.advanceTimersByTime(50);
            expect(globalStore.get(model.freeScrollAtom)).toBe(true);
            expect(layoutModel.updateTree).not.toHaveBeenCalled();
            expect(model.layout.columns[1].width).toBe(wide);
            expect(model.scrollLeft).toBe(layout.columns[1].x);
            // Let go: the zones are laid from the column that rests in the first one.
            vi.advanceTimersByTime(1000);
            expect(layoutModel.updateTree).toHaveBeenCalledTimes(1);
            expect(model.restColumnId).toBe("c2");
            expect(model.layout.columns[1].width / band).toBeCloseTo(0.3, 2);
            expect(model.scrollLeft).toBe(model.layout.columns[1].x);
        } finally {
            vi.useRealTimers();
        }
    });

    it("forgets the shares of a number of zones when that number is applied again", () => {
        const meta = { [View360PlacesMetaKey]: 2, [View360ZonesMetaKey]: { "2": [0.3, 0.7], "3": [0.2, 0.3, 0.5] } };
        const { model, pass } = makeModel(rowOf(7), meta, 3600);
        pass();
        expect(model.applyPlaces("b-c1", 2)).toBe(true);
        expect(model.zones()).toEqual({ "3": [0.2, 0.3, 0.5] });
        pass();
        expect(new Set(zoneWidths(model, 0, 2)).size).toBe(1);
    });

    it("keeps the shares of each number: 2 → 3 → 2 finds the zones of 2 as they were", () => {
        const meta = { [View360PlacesMetaKey]: 2, [View360ZonesMetaKey]: { "2": [0.3, 0.7] } };
        const { model, pass } = makeModel(rowOf(7), meta, 3600);
        pass();
        expect(model.applyPlaces("b-c1", 3)).toBe(true);
        pass();
        expect(model.zones()).toEqual({ "2": [0.3, 0.7] });
        expect(new Set(zoneWidths(model, 0, 3)).size).toBe(1);
        expect(model.applyPlaces("b-c1", 2)).toBe(true);
        pass();
        expect(model.zones()).toEqual({ "2": [0.3, 0.7] });
        const [a, b] = zoneWidths(model, 0, 2);
        expect(a / (a + b)).toBeCloseTo(0.3, 2);
    });

    it("gives them back with Undo of the apply", () => {
        const meta = { [View360PlacesMetaKey]: 2, [View360ZonesMetaKey]: { "2": [0.3, 0.7] } };
        const { model, pass } = makeModel(rowOf(7), meta, 3600);
        pass();
        model.applyPlaces("b-c1", 2);
        lastUndo()();
        expect(model.zones()).toEqual({ "2": [0.3, 0.7] });
    });
});

describe("Even out the zones (FR-SHELL-123 AC20)", () => {
    const uneven = { [View360PlacesMetaKey]: 2, [View360ZonesMetaKey]: { "2": [0.3, 0.7] } };

    it("gives the zones equal widths and forgets the shares, with the message and its Undo", () => {
        const { model, pass, layoutModel } = makeModel(rowOf(7), uneven, 3600);
        layoutModel.updateTree = vi.fn(() => void pass());
        pass();
        expect(model.evenZonesWhy()).toBeNull();
        expect(model.evenZones()).toBe(true);
        expect(model.zones()).toEqual({});
        expect(metaWrites().at(-1)).toEqual({ [View360ZonesMetaKey]: null });
        const [a, b] = zoneWidths(model, 0, 2);
        expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
        expect(vi.mocked(showToast).mock.calls.at(-1)[0]).toMatchObject({
            id: ZonesToastId,
            title: "Zones evened out",
            message: "The 2 zones now share the width equally: 50 / 50 %.",
            dismissMs: PlacesUndoMs,
        });
    });

    it("gives three zones 33 / 34 / 33 percent of the band, as the message says", () => {
        const meta = { [View360PlacesMetaKey]: 3, [View360ZonesMetaKey]: { "3": [0.2, 0.3, 0.5] } };
        const { model, pass, layoutModel } = makeModel(rowOf(7), meta, 3600);
        layoutModel.updateTree = vi.fn(() => void pass());
        const band = pass().viewport.width;
        expect(model.evenZones()).toBe(true);
        expect(vi.mocked(showToast).mock.calls.at(-1)[0].message).toBe(
            "The 3 zones now share the width equally: 33 / 34 / 33 %."
        );
        expect(model.zones()).toEqual({ "3": [0.33, 0.34, 0.33] });
        const [a, b, c] = zoneWidths(model);
        expect(a / band).toBeCloseTo(0.33, 2);
        expect(b / band).toBeCloseTo(0.34, 2);
        expect(c / band).toBeCloseTo(0.33, 2);
        expect(a + b + c).toBeGreaterThanOrEqual(Math.floor(band) - 1);
        // Even now: the action has nothing left to do, and Undo gives the widths back.
        expect(model.evenZonesWhy()).toBe("even");
        lastUndo()();
        expect(model.zones()).toEqual({ "3": [0.2, 0.3, 0.5] });
    });

    it("draws the layout once for the action and once for its Undo", () => {
        const { model, pass, layoutModel } = makeModel(rowOf(7), uneven, 3600);
        layoutModel.updateTree = vi.fn(() => void pass());
        pass();
        model.evenZones();
        expect(layoutModel.updateTree).toHaveBeenCalledTimes(1);
        lastUndo()();
        expect(layoutModel.updateTree).toHaveBeenCalledTimes(2);
    });

    it("is undone for 10 s: the zones take their widths back", () => {
        const { model, pass, layoutModel } = makeModel(rowOf(7), uneven, 3600);
        layoutModel.updateTree = vi.fn(() => void pass());
        pass();
        model.evenZones();
        lastUndo()();
        expect(model.zones()).toEqual({ "2": [0.3, 0.7] });
        const [a, b] = zoneWidths(model, 0, 2);
        expect(a / (a + b)).toBeCloseTo(0.3, 2);
    });

    it("is disabled, with its reason, when the zones are already even", () => {
        const { model, pass } = makeModel(rowOf(7), { [View360PlacesMetaKey]: 2 }, 3600);
        pass();
        expect(model.evenZonesWhy()).toBe("even");
        expect(model.evenZones()).toBe(false);
        expect(showToast).not.toHaveBeenCalled();
    });

    it("is disabled when a drag left the zones within a hundredth of even", () => {
        const { model, pass, rootNode } = makeModel(rowOf(7), { [View360PlacesMetaKey]: 2 }, 3600);
        const before = pass();
        const [a] = zoneWidths(model, 0, 2);
        dragBorder(model, rootNode, 0, before.viewport.left + a + 10);
        expect(model.zones()).toEqual({});
        expect(model.evenZonesWhy()).toBe("even");
    });

    it("is disabled, with its reason, when a single zone is in view", () => {
        const { model, pass } = makeModel(rowOf(7), { [View360PlacesMetaKey]: 1 }, 3600);
        pass();
        expect(model.evenZonesWhy()).toBe("single");
        expect(model.evenZones()).toBe(false);
    });

    it("is disabled outside a 360 × N", () => {
        const { model, pass } = makeModel(rowOf(3), {}, 3600);
        pass();
        expect(model.evenZonesWhy()).toBe("single");
    });

    it("Equalize gives the zones equal widths too (FR-SHELL-073)", () => {
        const { model, pass } = makeModel(rowOf(7), uneven, 3600);
        pass();
        expect(model.equalizeParts()).not.toBeNull();
        expect(model.zones()).toEqual({});
        expect(model.equalizeParts()).toBeNull();
    });
});
