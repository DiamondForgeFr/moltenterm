// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import type { LayoutModel } from "@/layout/lib/layoutModel";
import { findNode } from "@/layout/lib/layoutNode";
import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { atom, type PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { carpetScrollStops } from "./carpet-model";
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

const Wide = { top: 0, left: 0, width: 2400, height: 900 };

function leaf(id: string): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size: 10, data: { blockId: `b-${id}` } };
}

function carpetOf(n: number): { model: View360Model; stops: number[] } {
    const rootNode: LayoutNode = {
        id: "root",
        flexDirection: FlexDirection.Row,
        size: 10,
        children: Array.from({ length: n }, (_, i) => leaf(`c${i}`)),
    };
    const tabAtom = atom({ oid: "tab-1", meta: {} } as unknown as Tab) as PrimitiveAtom<Tab>;
    const layoutModel = {
        focusedNode: atom(null as LayoutNode),
        updateTree: vi.fn(),
        treeReducer: vi.fn(),
        treeState: { rootNode },
        displayContainerRef: { current: null },
        getNodeByBlockId: (blockId: string) => findNode(rootNode, blockId.replace(/^b-/, "")),
        focusNode: vi.fn(),
    } as unknown as LayoutModel;
    const model = new View360Model(layoutModel, tabAtom);
    model.evaluate(rootNode, Wide);
    model.computeLayout(rootNode, Wide);
    model.applyPlaces("b-c1", 1);
    model.evaluate(rootNode, Wide);
    const layout = model.computeLayout(rootNode, Wide);
    return { model, stops: carpetScrollStops(layout) };
}

// Chromium's frame order (#1405): the wheel events of a frame are dispatched first, then its requestAnimationFrame
// callbacks run, the carpet's glide among them.
describe("one trackpad swipe moves the 360 carpet exactly one panel (FR-SHELL-123, #1466)", () => {
    let queued = new Map<number, FrameRequestCallback>();
    let nextId = 1;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
        queued = new Map();
        vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
            const id = nextId++;
            queued.set(id, fn);
            return id;
        });
        vi.stubGlobal("cancelAnimationFrame", (id: number) => queued.delete(id));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    function runFrame() {
        const callbacks = Array.from(queued.values());
        queued.clear();
        callbacks.forEach((fn) => fn(performance.now()));
    }

    // One wheel event per 60 Hz frame (null: a frame without one), then the frame's callbacks.
    function frames(model: View360Model, dxs: number[]) {
        for (const dx of dxs) {
            vi.advanceTimersByTime(16);
            if (dx != null) {
                model.scrollBy(dx);
            }
            runFrame();
        }
    }

    function settle() {
        for (let i = 0; i < 120; i++) {
            vi.advanceTimersByTime(16);
            runFrame();
        }
    }

    // The fingers: a quick ramp, then a steady pace.
    function fingers(pace: number, count = 10): number[] {
        const ramp = [0.2, 0.45, 0.75].map((r) => Math.round(pace * r));
        return [...ramp, ...Array(count).fill(pace)];
    }

    // A trackpad's momentum at 60 Hz: a tail decaying to nothing over about 1.2 s (no gap: an event every frame), with
    // now and then a delta a pixel or two the other way, and a frame the busy main thread coalesced into the next.
    function tail(from: number, reversals = false): number[] {
        const out: number[] = [];
        for (let v = Math.abs(from) * 0.96, i = 0; Math.round(v) > 0; v *= 0.96, i++) {
            out.push(Math.sign(from) * (reversals && i > 4 && i % 9 === 0 ? -2 : Math.round(v)));
        }
        if (reversals) {
            out.splice(12, 2, out[12] + out[13]);
        }
        return out;
    }

    it("one swipe with a long decaying tail moves one panel", () => {
        const { model, stops } = carpetOf(8);
        frames(model, [...fingers(20), ...tail(20)]);
        settle();
        expect(model.scrollLeft).toBe(stops[1]);
    });

    it("one swipe with small reversals in its tail moves one panel", () => {
        const { model, stops } = carpetOf(8);
        frames(model, [...fingers(20), ...tail(20, true)]);
        settle();
        expect(model.scrollLeft).toBe(stops[1]);
    });

    it("a fast flick and a slow long swipe each move one panel, both ways", () => {
        const { model, stops } = carpetOf(8);
        frames(model, [...fingers(60, 4), ...tail(60, true)]);
        settle();
        expect(model.scrollLeft).toBe(stops[1]);
        frames(model, [...fingers(6, 40), ...tail(6)]);
        settle();
        expect(model.scrollLeft).toBe(stops[2]);
        frames(model, [...fingers(-30), ...tail(-30, true)]);
        settle();
        expect(model.scrollLeft).toBe(stops[1]);
    });

    it("two deliberate swipes in a row move two panels, the second interrupting the first's momentum", () => {
        const { model, stops } = carpetOf(8);
        // The fingers touching down stop the momentum: a few frames without an event before they move again.
        frames(model, [...fingers(20), ...tail(20).slice(0, 20), null, null, null, null, ...fingers(20), ...tail(20)]);
        settle();
        expect(model.scrollLeft).toBe(stops[2]);
    });

    it("two deliberate swipes move two panels when the second takes over the momentum without a pause", () => {
        const { model, stops } = carpetOf(8);
        frames(model, [...fingers(20), ...tail(20).slice(0, 20), ...fingers(24), ...tail(24, true)]);
        settle();
        expect(model.scrollLeft).toBe(stops[2]);
    });

    it("a reversed swipe right after the first one comes back one panel", () => {
        const { model, stops } = carpetOf(8);
        frames(model, [...fingers(20), ...tail(20).slice(0, 25), ...fingers(-20), ...tail(-20)]);
        settle();
        expect(model.scrollLeft).toBe(stops[0]);
    });

    it("three swipes lifted apart move three panels", () => {
        const { model, stops } = carpetOf(8);
        const swipe = [...fingers(20), ...tail(20), null, null, null, null, null, null, null, null, null, null];
        frames(model, [...swipe, ...swipe, ...swipe]);
        settle();
        expect(model.scrollLeft).toBe(stops[3]);
    });
});
