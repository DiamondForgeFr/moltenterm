// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    writes: [] as Record<string, unknown>[],
    gone: null as (pageId: number) => void,
    subscriptions: 0,
}));
const SizeSetting = vi.hoisted(() => ({ atom: null as any }));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    SizeSetting.atom = atom(undefined);
    return {
        getSettingsKeyAtom: () => SizeSetting.atom,
        getApi: () => ({
            onMoltentermInspectorGone: (cb: (pageId: number) => void) => {
                state.subscriptions++;
                state.gone = cb;
                return () => {};
            },
        }),
    };
});
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetConfigCommand: async (_client: unknown, data: Record<string, unknown>) => {
            state.writes.push(data);
        },
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { globalStore } from "@/app/store/jotaiStore";
import {
    BrowserInspectorModel,
    clampInspectorSize,
    clippingAncestors,
    coveredRect,
    draggedInspectorSize,
    inspectorPlace,
    inspectorSize,
    InspectorSizeDefault,
    InspectorSizeKey,
    keyedInspectorSize,
    onInspectorGone,
    shownRect,
    shownRectWithin,
} from "./browser-inspector";

beforeEach(() => {
    state.writes = [];
    globalStore.set(SizeSetting.atom, undefined);
});

describe("the size of the docked tools (FR-BRW-022 AC2, TC-BRW-053)", () => {
    it("reads the stored share, and the default for anything else", () => {
        expect(inspectorSize(0.3)).toBe(0.3);
        for (const raw of [undefined, null, "0.3", 0.05, 0.95, NaN]) {
            expect(inspectorSize(raw), String(raw)).toBe(InspectorSizeDefault);
        }
    });

    it("grows when the divider goes up, within 15 % and 85 % of the page area", () => {
        expect(draggedInspectorSize(0.4, 500, 400, 1000)).toBeCloseTo(0.5);
        expect(draggedInspectorSize(0.4, 500, 600, 1000)).toBeCloseTo(0.3);
        expect(draggedInspectorSize(0.4, 500, -2000, 1000)).toBe(0.85);
        expect(draggedInspectorSize(0.4, 500, 3000, 1000)).toBe(0.15);
        expect(draggedInspectorSize(0.4, 500, 100, 0)).toBe(0.4);
        expect(clampInspectorSize(2)).toBe(0.85);
    });

    it("follows the divider's arrow keys, Home and End", () => {
        expect(keyedInspectorSize(0.4, "ArrowUp")).toBeCloseTo(0.45);
        expect(keyedInspectorSize(0.4, "ArrowDown")).toBeCloseTo(0.35);
        expect(keyedInspectorSize(0.84, "ArrowUp")).toBe(0.85);
        expect(keyedInspectorSize(0.4, "Home")).toBe(0.85);
        expect(keyedInspectorSize(0.4, "End")).toBe(0.15);
        expect(keyedInspectorSize(0.4, "Enter")).toBeNull();
    });

    it("keeps the dragged size until the setting comes back with it, and saves it for every panel", async () => {
        const model = new BrowserInspectorModel();
        expect(globalStore.get(model.sizeAtom)).toBe(InspectorSizeDefault);
        model.setDragSize(0.62);
        expect(globalStore.get(model.sizeAtom)).toBe(0.62);
        model.saveSize(0.9);
        expect(globalStore.get(model.sizeAtom)).toBe(0.85);
        await Promise.resolve();
        expect(state.writes).toEqual([{ [InspectorSizeKey]: 0.85 }]);
        globalStore.set(SizeSetting.atom, 0.85);
        model.setDragSize(null);
        expect(globalStore.get(model.sizeAtom)).toBe(0.85);
        expect(globalStore.get(new BrowserInspectorModel().sizeAtom)).toBe(0.85);
    });
});

describe("which pages have their tools docked (FR-BRW-022 AC3, AC4)", () => {
    it("opens, selects again, closes and toggles per tab", () => {
        const model = new BrowserInspectorModel();
        model.open("t1", { x: 4, y: 5 });
        const first = model.entries().t1;
        expect(first.point).toEqual({ x: 4, y: 5 });
        model.open("t1", { x: 9, y: 9 });
        expect(model.entries().t1.nonce).toBeGreaterThan(first.nonce);
        expect(model.isOpen("t2")).toBe(false);
        model.pageIds.set("t1", 77);
        expect(model.tabOfPage(77)).toBe("t1");
        model.toggle("t1");
        expect(model.isOpen("t1")).toBe(false);
        expect(model.tabOfPage(77)).toBeNull();
        model.toggle("t1");
        expect(model.entries().t1.point).toBeUndefined();
    });

    it("hears once for the window that a page's tools went away", () => {
        const seen: number[] = [];
        const off = onInspectorGone((id) => seen.push(id));
        onInspectorGone((id) => seen.push(-id));
        expect(state.subscriptions).toBe(1);
        state.gone(42);
        off();
        state.gone(43);
        expect(seen).toEqual([42, -42, -43]);
    });
});

type Box = { left: number; top: number; right: number; bottom: number };

function el(box: Box, overflow = "visible", parent: any = null): any {
    return {
        parentElement: parent,
        overflow,
        getBoundingClientRect: () => box,
        contains(other: any) {
            for (let n = other; n != null; n = n.parentElement) {
                if (n === this) {
                    return true;
                }
            }
            return false;
        },
    };
}

const win = (width: number, height: number): any => ({
    innerWidth: width,
    innerHeight: height,
    getComputedStyle: (e: any) => ({ overflow: e.overflow, overflowX: e.overflow, overflowY: e.overflow }),
});

describe("where the pane shows (FR-BRW-022 AC4, DS-BRW-027)", () => {
    it("cuts the pane by its scrolling ancestors and the window: the 360 carpet shows part of a panel", () => {
        const carpet = el({ left: 200, top: 0, right: 900, bottom: 800 }, "hidden");
        const panel = el({ left: 600, top: 0, right: 1200, bottom: 800 }, "visible", carpet);
        const body = el({ left: 600, top: 500, right: 1200, bottom: 900 }, "visible", panel);
        expect(shownRect(body, win(1000, 850))).toEqual({ left: 600, top: 500, right: 900, bottom: 800 });
    });

    it("reads the clipping ancestors once, then follows the carpet's scroll with their boxes alone", () => {
        let carpetLeft = 200;
        const carpet: any = el({ left: 0, top: 0, right: 0, bottom: 0 }, "hidden");
        carpet.getBoundingClientRect = () => ({ left: carpetLeft, top: 0, right: carpetLeft + 700, bottom: 800 });
        const panel = el({ left: 600, top: 0, right: 1200, bottom: 800 }, "visible", carpet);
        const body = el({ left: 600, top: 500, right: 1200, bottom: 900 }, "visible", panel);
        const w = win(2000, 1000);
        const styles = vi.spyOn(w, "getComputedStyle");
        const clippers = clippingAncestors(body, w);
        expect(clippers).toEqual([carpet]);
        expect(styles).toHaveBeenCalledTimes(2);
        expect(shownRectWithin(body, clippers, w)).toMatchObject({ left: 600, right: 900 });
        carpetLeft = 500;
        expect(shownRectWithin(body, clippers, w)).toMatchObject({ left: 600, right: 1200 });
        expect(styles).toHaveBeenCalledTimes(2);
    });

    it("places the tools on events and a 100 ms check, never at every frame", () => {
        const source = readFileSync(resolve(__dirname, "inspector-pane.tsx"), "utf8");
        expect(source).not.toMatch(/requestAnimationFrame/);
        expect(source).toMatch(/new ResizeObserver\(/);
        expect(source).toMatch(/addEventListener\("scroll", onMove, true\)/);
        expect(source).toMatch(/const CoverCheckMs = 100;/);
    });

    it("hides a pane too small to show the tools", () => {
        expect(inspectorPlace({ left: 0, top: 0, right: 600, bottom: 30 }, true).visible).toBe(false);
        expect(inspectorPlace({ left: 10.4, top: 20.6, right: 610, bottom: 320 }, true)).toEqual({
            x: 10,
            y: 21,
            width: 600,
            height: 299,
            visible: true,
        });
        expect(inspectorPlace({ left: 500, top: 0, right: 100, bottom: 300 }, true)).toMatchObject({
            width: 0,
            visible: false,
        });
    });

    it("is covered when a surface of the window lies over any of nine points", () => {
        const body = el({ left: 0, top: 0, right: 300, bottom: 300 });
        const child = el({ left: 0, top: 0, right: 10, bottom: 10 }, "visible", body);
        const menu = el({ left: 250, top: 250, right: 400, bottom: 400 });
        const doc = (top: (x: number, y: number) => any): any => ({ elementFromPoint: top });
        expect(
            coveredRect(
                { left: 0, top: 0, right: 300, bottom: 300 },
                body,
                doc(() => body)
            )
        ).toBe(false);
        expect(
            coveredRect(
                { left: 0, top: 0, right: 300, bottom: 300 },
                body,
                doc(() => child)
            )
        ).toBe(false);
        expect(
            coveredRect(
                { left: 0, top: 0, right: 300, bottom: 300 },
                body,
                doc(() => null)
            )
        ).toBe(false);
        expect(
            coveredRect(
                { left: 0, top: 0, right: 300, bottom: 300 },
                body,
                doc((x, y) => (x > 250 && y > 250 ? menu : body))
            )
        ).toBe(true);
    });
});
