// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import type { LayoutModel } from "@/layout/lib/layoutModel";
import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { atom, type PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CarpetLayout } from "./carpet-model";
import { besideZonePx, equalizePlaceCount, equalParts, placesFixedPx } from "./carpet-places";
import { View360MetaKey, View360PinsMetaKey, View360PlacesMetaKey } from "./view360-meta";
import { View360Model } from "./view360-model";

const floor = vi.hoisted(() => ({ px: null as number }));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { getSettingsKeyAtom: () => atom<string>("auto") };
});
vi.mock("./screen-store", async () => {
    const { atom } = await import("jotai");
    const thresholdAtom = atom(8);
    return { ScreenModel: { getInstance: () => ({ thresholdAtom }) } };
});
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(() => Promise.resolve()) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("../toast-store", () => ({ showToast: vi.fn(() => "toast:1") }));
vi.mock("../panel-size/panel-size-store", () => ({
    cachedBlockView: () => "web",
    currentPanelSizes: () => ({}),
    currentFirstColumnFloorPx: () => floor.px,
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

function rowOf(n: number): LayoutNode {
    return {
        id: "root",
        flexDirection: FlexDirection.Row,
        size: 10,
        children: Array.from({ length: n }, (_, i) => leaf(`c${i}`)),
    };
}

function makeModel(rootNode: LayoutNode, meta: Record<string, unknown>) {
    const tabAtom = atom({ oid: "tab-1", meta } as unknown as Tab) as PrimitiveAtom<Tab>;
    const layoutModel = {
        focusedNode: atom(null as LayoutNode),
        updateTree: vi.fn(),
        treeReducer: vi.fn(),
        treeState: { rootNode },
        displayContainerRef: { current: null },
        focusNode: vi.fn(),
    } as unknown as LayoutModel;
    const model = new View360Model(layoutModel, tabAtom);
    const pass = (bounds = Wide) => {
        model.evaluate(rootNode, bounds);
        return model.computeLayout(rootNode, bounds);
    };
    return { model, pass };
}

function firstColumnPx(layout: CarpetLayout): number {
    return layout.fixedColumns[0].rect.width;
}

function bandOf(widths: number[], viewportPx: number): CarpetLayout {
    return {
        viewport: { top: 0, left: 0, width: viewportPx, height: 800 },
        columns: widths.map((width, i) => ({ nodeId: `c${i}`, x: 0, width })),
    } as CarpetLayout;
}

beforeEach(() => {
    floor.px = null;
});

describe("equal parts of an equalize in 360 view (#1479)", () => {
    it("gives the first column and each place the same share for N = 1, 2 and 3", () => {
        for (const n of [1, 2, 3]) {
            const parts = equalParts(Wide.width, n);
            expect(parts.fixedPx).toBe(placesFixedPx(Wide.width, n));
            expect(Math.abs(parts.fixedPx - parts.placePx)).toBeLessThanOrEqual(1);
        }
    });

    it("keeps the 520 px minimum and the terminal floor, the places sharing what is left", () => {
        const narrow = equalParts(1000, 1);
        expect(narrow.fixedPx).toBeGreaterThanOrEqual(520);
        expect(narrow.placePx).toBeLessThan(narrow.fixedPx);
        const floored = equalParts(Wide.width, 2, 1000);
        expect(floored.fixedPx).toBe(1000);
        expect(floored.placePx).toBeLessThan(1000);
    });

    it("leaves the columns pinned beside at their widths", () => {
        const beside = besideZonePx([500]);
        const parts = equalParts(Wide.width, 2, 0, beside);
        expect(Math.abs(parts.fixedPx - parts.placePx)).toBeLessThanOrEqual(1);
        expect(parts.fixedPx).toBeLessThan(equalParts(Wide.width, 2).fixedPx);
    });

    it("counts the places: the view's N, otherwise what the band holds at the columns' mean width", () => {
        expect(equalizePlaceCount(bandOf([600, 600, 600], 1200), 2, Wide.width)).toBe(2);
        expect(equalizePlaceCount(bandOf([1400, 1400], 1400), null, Wide.width)).toBe(1);
        expect(equalizePlaceCount(bandOf([400, 1000], 1400), null, Wide.width)).toBe(2);
        expect(equalizePlaceCount(bandOf([400, 400, 400, 400, 400], 1400), null, Wide.width)).toBe(3);
        expect(equalizePlaceCount(bandOf([300], 1400), null, Wide.width)).toBe(1);
        expect(equalizePlaceCount(bandOf([600, 600, 600], 1200), null, 1200)).toBe(1);
        expect(equalizePlaceCount(bandOf([], 1200), null, Wide.width)).toBe(0);
    });
});

describe("View360Model.equalizeParts (#1479)", () => {
    it("in the plain 360 view, evens out a fixed zone dragged uneven against the carpet column", () => {
        const { model, pass } = makeModel(rowOf(2), { [View360MetaKey]: true });
        pass();
        model.grippedFixedPx = 900;
        let layout = pass();
        expect(firstColumnPx(layout)).toBe(900);
        expect(model.equalizeParts()).not.toBeNull();
        layout = pass();
        const fixed = placesFixedPx(Wide.width, 1);
        expect(firstColumnPx(layout)).toBe(fixed);
        expect(Math.abs(layout.columns[0].width - fixed)).toBeLessThanOrEqual(1);
        expect(model.equalizeParts()).toBeNull();
    });

    it("in the plain 360 view, gives two carpet columns in view a third each", () => {
        const { model, pass } = makeModel(rowOf(3), { [View360MetaKey]: true });
        pass();
        model.grippedFixedPx = 700;
        model.carpetPx.set("c1", 500);
        model.carpetPx.set("c2", 900);
        pass();
        expect(model.equalizeParts()).not.toBeNull();
        const layout = pass();
        const fixed = placesFixedPx(Wide.width, 2);
        expect(firstColumnPx(layout)).toBe(fixed);
        for (const column of layout.columns) {
            expect(Math.abs(column.width - fixed)).toBeLessThanOrEqual(1);
        }
        expect(model.equalizeParts()).toBeNull();
    });

    it("under a 360 × N, drops the widths dragged by hand for the view's equal parts", () => {
        for (const n of [1, 2, 3]) {
            const { model, pass } = makeModel(rowOf(5), { [View360PlacesMetaKey]: n });
            pass();
            model.grippedFixedPx = 600;
            model.carpetPx.set("c1", 900);
            pass();
            expect(model.equalizeParts()).not.toBeNull();
            expect(model.grippedFixedPx).toBeNull();
            const layout = pass();
            const fixed = placesFixedPx(Wide.width, n);
            expect(firstColumnPx(layout)).toBe(fixed);
            for (const column of layout.columns) {
                expect(Math.abs(column.width - fixed)).toBeLessThanOrEqual(1);
            }
            expect(model.equalizeParts()).toBeNull();
        }
    });

    it("keeps a column pinned beside at its width", () => {
        const pins = { "b-c1": { mode: "beside", px: 500 } };
        const { model, pass } = makeModel(rowOf(5), { [View360PlacesMetaKey]: 2, [View360PinsMetaKey]: pins });
        pass();
        model.grippedFixedPx = 600;
        const before = pass().fixedColumns[1].rect.width;
        expect(model.equalizeParts()).not.toBeNull();
        const layout = pass();
        expect(layout.fixedColumns[1].rect.width).toBe(before);
        expect(Math.abs(firstColumnPx(layout) - layout.columns[0].width)).toBeLessThanOrEqual(1);
    });

    it("does nothing outside the 360 view or while a width is dragged", () => {
        const { model, pass } = makeModel(rowOf(2), {});
        pass();
        expect(model.layout).toBeNull();
        expect(model.equalizeParts()).toBeNull();
        const inView = makeModel(rowOf(2), { [View360MetaKey]: true });
        inView.pass();
        inView.model.dragFixedPx = 800;
        expect(inView.model.equalizeParts()).toBeNull();
    });
});
