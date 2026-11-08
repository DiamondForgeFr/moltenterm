// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { RevealMaxTries, ShowInViewDeps, showPanelInView } from "./carpet-show";

function makeDeps(over: Partial<ShowInViewDeps> = {}) {
    const calls: string[] = [];
    const pending: (() => void)[] = [];
    const deps: ShowInViewDeps = {
        showPanel: (blockId) => {
            calls.push(`show ${blockId}`);
            return true;
        },
        reveal: (blockId) => {
            calls.push(`reveal ${blockId}`);
        },
        carpetReady: () => true,
        later: (fn) => {
            pending.push(fn);
        },
        ...over,
    };
    return { deps, calls, pending };
}

describe("showing a panel on the 360 carpet (#1992, shared with #1994)", () => {
    it("focuses the panel, then glides the carpet so its column is in view", () => {
        const { deps, calls } = makeDeps();
        expect(showPanelInView("b1", deps)).toBe(true);
        expect(calls).toEqual(["show b1", "reveal b1"]);
    });

    it("does not reveal a panel that is not laid out, and says so for the caller to try again", () => {
        const { deps, calls } = makeDeps({ showPanel: () => false });
        expect(showPanelInView("b1", deps)).toBe(false);
        expect(calls).toEqual([]);
    });

    it("waits for a carpet that is not drawn yet, then reveals once", () => {
        let ready = false;
        const { deps, calls, pending } = makeDeps({ carpetReady: () => ready });
        expect(showPanelInView("b1", deps)).toBe(true);
        expect(calls).toEqual(["show b1"]);
        expect(pending.length).toBe(1);
        ready = true;
        pending.shift()();
        expect(calls).toEqual(["show b1", "reveal b1"]);
        expect(pending.length).toBe(0);
    });

    it("gives up after a bounded number of tries outside 360 view, where there is nothing to reveal", () => {
        const { deps, calls, pending } = makeDeps({ carpetReady: () => false });
        showPanelInView("b1", deps);
        let tries = 0;
        while (pending.length > 0) {
            pending.shift()();
            tries++;
        }
        expect(calls).toEqual(["show b1"]);
        expect(tries).toBe(RevealMaxTries - 1);
    });
});
