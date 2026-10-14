// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { whileShown } from "../tab-activity";
import { computeCarpetLayout } from "./carpet-model";
import {
    everyInPanel,
    isOffCarpet,
    keepLiveAtom,
    offCarpetAtom,
    OffCarpetDelayMs,
    OffCarpetTracker,
    panelActivity,
    setKeepLive,
} from "./offcarpet-model";
import { carpetColumnBlocks, fixedZoneBlockIds } from "./view360-offcarpet";

function makeTracker() {
    const flags = new Map<string, boolean>();
    const calls: string[] = [];
    const tracker = new OffCarpetTracker(
        (blockId, off) => {
            flags.set(blockId, off);
            calls.push(`${blockId}:${off ? "off" : "on"}`);
        },
        { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) }
    );
    tracker.setColumns([
        { columnId: "c1", blockIds: ["a"] },
        { columnId: "c2", blockIds: ["b", "c"] },
    ]);
    return { tracker, flags, calls };
}

describe("off-carpet tracker (#618)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("throttles a column only once it has stayed out of view for the delay", () => {
        const { tracker, calls } = makeTracker();
        tracker.noteInView("c2", false);
        vi.advanceTimersByTime(OffCarpetDelayMs - 1);
        expect(calls).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(calls).toEqual(["b:off", "c:off"]);
    });

    it("never throttles a column scrolled past or back before the delay", () => {
        const { tracker, calls } = makeTracker();
        tracker.noteInView("c1", false);
        vi.advanceTimersByTime(OffCarpetDelayMs / 2);
        tracker.noteInView("c1", true);
        vi.advanceTimersByTime(OffCarpetDelayMs * 3);
        expect(calls).toEqual([]);
    });

    it("brings a column back at once", () => {
        const { tracker, flags } = makeTracker();
        tracker.noteInView("c1", false);
        vi.advanceTimersByTime(OffCarpetDelayMs);
        expect(flags.get("a")).toBe(true);
        tracker.noteInView("c1", true);
        expect(flags.get("a")).toBe(false);
    });

    it("keeps the focused, magnified or kept-live panels live", () => {
        const { tracker, flags } = makeTracker();
        tracker.setExempt(["c"]);
        tracker.noteInView("c2", false);
        vi.advanceTimersByTime(OffCarpetDelayMs);
        expect(flags.get("b")).toBe(true);
        expect(flags.has("c")).toBe(false);
        tracker.setExempt(["b"]);
        expect(flags.get("b")).toBe(false);
        expect(flags.get("c")).toBe(true);
    });

    it("never marks a pinned panel off-carpet, and frees it when it is pinned while off", () => {
        const { tracker, flags } = makeTracker();
        tracker.noteInView("c2", false);
        vi.advanceTimersByTime(OffCarpetDelayMs);
        expect(flags.get("b")).toBe(true);
        // "b" is pinned to the fixed zone: it leaves the carpet's columns and joins the fixed zone.
        tracker.setColumns(
            [
                { columnId: "c1", blockIds: ["a"] },
                { columnId: "c2", blockIds: ["c"] },
            ],
            ["first", "b"]
        );
        expect(flags.get("b")).toBe(false);
        expect(flags.get("c")).toBe(true);
        // Even a stale column list that still names it never throttles it.
        tracker.setColumns([{ columnId: "c2", blockIds: ["b", "c"] }], ["b"]);
        vi.advanceTimersByTime(OffCarpetDelayMs * 3);
        expect(flags.get("b")).toBe(false);
    });

    it("follows the blocks of a column when the tree changes, and clears everything on leaving the view", () => {
        const { tracker, flags } = makeTracker();
        tracker.noteInView("c2", false);
        vi.advanceTimersByTime(OffCarpetDelayMs);
        tracker.setColumns([
            { columnId: "c1", blockIds: ["a"] },
            { columnId: "c2", blockIds: ["b"] },
        ]);
        expect(flags.get("c")).toBe(false);
        expect(flags.get("b")).toBe(true);
        tracker.setColumns([{ columnId: "c1", blockIds: ["a", "b"] }]);
        expect(flags.get("b")).toBe(false);
        tracker.noteInView("c1", false);
        vi.advanceTimersByTime(OffCarpetDelayMs);
        expect(flags.get("a")).toBe(true);
        tracker.clear();
        expect([...flags.values()].every((off) => !off)).toBe(true);
    });
});

describe("carpet columns and fixed zone (#618, #616)", () => {
    it("leaves a pinned column out of the carpet's columns and counts its panels in the fixed zone", () => {
        const leaf = (id: string): LayoutNode => ({
            id,
            flexDirection: FlexDirection.Column,
            size: 10,
            data: { blockId: `b-${id}` },
        });
        const root: LayoutNode = {
            id: "root",
            flexDirection: FlexDirection.Row,
            size: 10,
            children: [leaf("first"), leaf("pinned"), leaf("carpet")],
        };
        const layout = computeCarpetLayout({
            width: 2000,
            height: 1000,
            fixedNodeId: "first",
            fixedPx: 600,
            columns: [{ nodeId: "carpet", widthPx: 600 }],
            pins: [{ nodeId: "pinned", mode: "beside", widthPx: 400 }],
        });
        expect(carpetColumnBlocks(root, layout)).toEqual([{ columnId: "carpet", blockIds: ["b-carpet"] }]);
        expect(fixedZoneBlockIds(root, layout).sort()).toEqual(["b-first", "b-pinned"]);
    });
});

describe("panel activity (#618)", () => {
    it("counts a shown panel off the carpet as hidden, and leaves other states alone", () => {
        expect(panelActivity("active", false)).toBe("active");
        expect(panelActivity("active", true)).toBe("hidden");
        expect(panelActivity("visible", true)).toBe("hidden");
        expect(panelActivity("minimized", true)).toBe("minimized");
        expect(panelActivity("hidden", false)).toBe("hidden");
    });

    it("keep-live flags are set and cleared per block", () => {
        setKeepLive("k1", true);
        expect(globalStore.get(keepLiveAtom)).toEqual({ k1: true });
        setKeepLive("k1", false);
        expect(globalStore.get(keepLiveAtom)).toEqual({});
    });
});

describe("everyInPanel (#618)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("pauses a panel's job off the carpet and runs it once, overdue, on return", () => {
        const runs: string[] = [];
        const stop = everyInPanel("p1", whileShown(1000), (reason) => runs.push(reason), "test");
        vi.advanceTimersByTime(1000);
        expect(runs).toEqual(["tick"]);
        globalStore.set(offCarpetAtom("p1"), true);
        expect(isOffCarpet("p1")).toBe(true);
        vi.advanceTimersByTime(10000);
        expect(runs).toEqual(["tick"]);
        globalStore.set(offCarpetAtom("p1"), false);
        expect(runs).toEqual(["tick", "resume"]);
        stop();
        vi.advanceTimersByTime(10000);
        expect(runs).toEqual(["tick", "resume"]);
    });

    it("is the tab view's own job without a panel", () => {
        const runs: string[] = [];
        const stop = everyInPanel(null, whileShown(1000), (reason) => runs.push(reason), "test");
        vi.advanceTimersByTime(2000);
        expect(runs).toEqual(["tick", "tick"]);
        stop();
    });
});
