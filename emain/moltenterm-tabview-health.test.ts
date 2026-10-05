// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
    ensureTabViewPainted,
    isRendering,
    MoltentermLongHiddenMs,
    ShownViewProbe,
    TabViewPaintTarget,
} from "./moltenterm-tabview-health";

const Rendering: ShownViewProbe = { visible: true, frames: 2 };
const Hidden: ShownViewProbe = { visible: false, frames: 0 };
const Frozen: ShownViewProbe = { visible: true, frames: 0 };

type Step = ShownViewProbe | "throw" | "hang";

function makeTarget(
    probes: Step[],
    opts: { hiddenForMs?: number; live?: () => boolean } = {}
): TabViewPaintTarget & { calls: string[] } {
    const calls: string[] = [];
    let n = 0;
    return {
        calls,
        isLive: opts.live ?? (() => true),
        hiddenForMs: () => opts.hiddenForMs ?? 0,
        probe: vi.fn(async () => {
            calls.push("probe");
            const step = probes[Math.min(n, probes.length - 1)];
            n++;
            if (step === "throw") {
                throw new Error("renderer gone");
            }
            if (step === "hang") {
                return new Promise<ShownViewProbe>(() => {});
            }
            return step;
        }),
        cycleVisibility: vi.fn(() => {
            calls.push("cycle");
        }),
        rebuild: vi.fn(async () => {
            calls.push("rebuild");
        }),
        log: () => {},
    };
}

describe("isRendering", () => {
    it("needs a visible page that ran animation frames", () => {
        expect(isRendering(Rendering)).toBe(true);
        expect(isRendering(Hidden)).toBe(false);
        expect(isRendering(Frozen)).toBe(false);
        expect(isRendering(null)).toBe(false);
    });
});

describe("ensureTabViewPainted", () => {
    it("only probes a view that was off-screen briefly and renders", async () => {
        const target = makeTarget([Rendering], { hiddenForMs: 5000 });
        expect(await ensureTabViewPainted(target, 0, 50)).toBe("rendering");
        expect(target.calls).toEqual(["probe"]);
    });

    it("cycles the visibility of a view that sat off-screen long enough to lose its frame", async () => {
        const target = makeTarget([Rendering], { hiddenForMs: MoltentermLongHiddenMs });
        expect(await ensureTabViewPainted(target, 0, 50)).toBe("refreshed");
        expect(target.calls).toEqual(["cycle", "probe"]);
    });

    it("cycles a view that does not render, and stops there once it does", async () => {
        const target = makeTarget([Hidden, Rendering]);
        expect(await ensureTabViewPainted(target, 0, 50)).toBe("repainted");
        expect(target.calls).toEqual(["probe", "cycle", "probe"]);
    });

    it("rebuilds a view that still does not render", async () => {
        const target = makeTarget([Frozen, Frozen]);
        expect(await ensureTabViewPainted(target, 0, 50)).toBe("rebuilt");
        expect(target.calls).toEqual(["probe", "cycle", "probe", "rebuild"]);
    });

    it("counts a failed or hanging probe as a view that does not render", async () => {
        const target = makeTarget(["throw", "hang"]);
        expect(await ensureTabViewPainted(target, 0, 20)).toBe("rebuilt");
    });

    it("leaves a view alone once it is no longer the shown one", async () => {
        let live = true;
        const target = makeTarget([Hidden], { live: () => live });
        target.cycleVisibility = vi.fn(() => {
            live = false;
        });
        expect(await ensureTabViewPainted(target, 0, 50)).toBe("skipped");
        expect(target.rebuild).not.toHaveBeenCalled();
    });

    it("skips a view switched away before the check", async () => {
        const target = makeTarget([Hidden], { live: () => false, hiddenForMs: MoltentermLongHiddenMs });
        expect(await ensureTabViewPainted(target, 0, 50)).toBe("skipped");
        expect(target.probe).not.toHaveBeenCalled();
        expect(target.cycleVisibility).not.toHaveBeenCalled();
    });
});
