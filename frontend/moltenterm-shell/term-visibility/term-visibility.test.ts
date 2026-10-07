// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    decideResize,
    decideWebglLossRecovery,
    ResizeInput,
    WebglLossWindowMs,
    WebglMaxLossesInWindow,
} from "./term-visibility";

function input(over: Partial<ResizeInput> = {}): ResizeInput {
    return {
        hidden: false,
        hasSized: true,
        elemWidth: 900,
        elemHeight: 600,
        proposedCols: 120,
        proposedRows: 40,
        curCols: 100,
        curRows: 30,
        ...over,
    };
}

describe("decideResize", () => {
    it("applies a new size when visible", () => {
        expect(decideResize(input())).toBe("apply");
    });

    it("does nothing when the size did not change", () => {
        expect(decideResize(input({ proposedCols: 100, proposedRows: 30 }))).toBe("none");
    });

    it("never sends a size for a pane that measures nothing", () => {
        expect(decideResize(input({ elemWidth: 0 }))).toBe("skip");
        expect(decideResize(input({ elemHeight: 0 }))).toBe("skip");
        expect(decideResize(input({ elemWidth: 0, elemHeight: 0, hidden: true }))).toBe("skip");
    });

    it("skips a fit that has no size to propose", () => {
        expect(decideResize(input({ proposedCols: undefined, proposedRows: undefined }))).toBe("skip");
        expect(decideResize(input({ proposedCols: NaN }))).toBe("skip");
        expect(decideResize(input({ proposedRows: 0 }))).toBe("skip");
    });

    it("defers a new size while a sized view is hidden", () => {
        expect(decideResize(input({ hidden: true }))).toBe("defer");
    });

    it("lets a hidden view that was never sized take its first size", () => {
        expect(decideResize(input({ hidden: true, hasSized: false }))).toBe("apply");
    });

    it("reports no change for a hidden view whose size is the same", () => {
        expect(decideResize(input({ hidden: true, proposedCols: 100, proposedRows: 30 }))).toBe("none");
    });

    it("applies the deferred size once visible", () => {
        expect(decideResize(input({ hidden: true }))).toBe("defer");
        expect(decideResize(input({ hidden: false }))).toBe("apply");
    });
});

describe("decideWebglLossRecovery", () => {
    it("recreates the renderer after the first loss", () => {
        const r = decideWebglLossRecovery([], 1000);
        expect(r.action).toBe("recreate");
        expect(r.losses).toEqual([1000]);
    });

    it("keeps recreating up to the limit, then settles on the DOM renderer", () => {
        let losses: number[] = [];
        const actions: string[] = [];
        for (let i = 0; i <= WebglMaxLossesInWindow; i++) {
            const r = decideWebglLossRecovery(losses, 1000 + i);
            losses = r.losses;
            actions.push(r.action);
        }
        expect(actions).toEqual(["recreate", "recreate", "dom"]);
    });

    it("forgets losses older than the window", () => {
        const old = [1000, 1001];
        const r = decideWebglLossRecovery(old, 1000 + WebglLossWindowMs + 5);
        expect(r.action).toBe("recreate");
        expect(r.losses).toEqual([1000 + WebglLossWindowMs + 5]);
    });

    it("copes with a missing history", () => {
        expect(decideWebglLossRecovery(undefined, 5).action).toBe("recreate");
    });
});
