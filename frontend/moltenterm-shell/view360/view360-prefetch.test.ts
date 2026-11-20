// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";
import "./view360-prefetch";

const loads = { chooser: 0, radar: 0 };

// The module keeps whether it started, and the heavy chunks are stand-ins that count their loads: each test takes a fresh
// copy of both. The module itself imports nothing heavy.
async function freshPrefetch() {
    vi.resetModules();
    vi.doMock("./view360-places-chooser", () => {
        loads.chooser++;
        return {};
    });
    vi.doMock("./view360-radar", () => {
        loads.radar++;
        return {};
    });
    return await import("./view360-prefetch");
}

describe("the 360 view's on-demand chunks are fetched ahead (#2433)", () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        loads.chooser = 0;
        loads.radar = 0;
    });

    it("loads the chooser and the tab strip once, in the app's window", async () => {
        vi.stubGlobal("window", { api: {} });
        const { prefetchView360Chunks } = await freshPrefetch();
        prefetchView360Chunks();
        prefetchView360Chunks();
        await vi.waitFor(() => expect(loads).toEqual({ chooser: 1, radar: 1 }), { timeout: 30000 });
    });

    it("waits for the window to be idle when asked to, then loads both", async () => {
        const queued: Array<() => void> = [];
        const idle = vi.fn((cb: () => void) => queued.push(cb));
        vi.stubGlobal("window", { api: {}, requestIdleCallback: idle });
        const { prefetchView360WhenIdle } = await freshPrefetch();
        prefetchView360WhenIdle();
        expect(idle).toHaveBeenCalledTimes(1);
        expect(loads).toEqual({ chooser: 0, radar: 0 });
        queued[0]();
        await vi.waitFor(() => expect(loads).toEqual({ chooser: 1, radar: 1 }), { timeout: 30000 });
    });

    it("fetches nothing outside the app's window: a test or a preview has no chunk to warm", async () => {
        vi.stubGlobal("window", {});
        const { prefetchView360Chunks, prefetchView360WhenIdle } = await freshPrefetch();
        prefetchView360Chunks();
        prefetchView360WhenIdle();
        expect(loads).toEqual({ chooser: 0, radar: 0 });
    });
});
