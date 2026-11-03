// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { ElectronThumbBackend, startCarpetThumbCleanup } from "./carpet-thumbs";

const mocks = vi.hoisted(() => ({
    subscriptions: [] as { eventType: string; handler: (event: { data?: string }) => void }[],
    api: {} as Record<string, any>,
}));

vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: (subscription: any) => {
        mocks.subscriptions.push(subscription);
        return () => {};
    },
}));

vi.mock("@/app/store/global", () => ({
    getApi: () => mocks.api,
}));

describe("startCarpetThumbCleanup (a closed panel's thumbnail goes with it)", () => {
    it("removes the thumbnail of every block the backend says closed, and subscribes once", () => {
        const removed: string[][] = [];
        const backend = { read: async () => ({}), put: () => {}, remove: (keys: string[]) => removed.push(keys) };
        startCarpetThumbCleanup(backend);
        startCarpetThumbCleanup(backend);
        expect(mocks.subscriptions).toHaveLength(1);
        expect(mocks.subscriptions[0].eventType).toBe("blockclose");

        mocks.subscriptions[0].handler({ data: "block-1" });
        mocks.subscriptions[0].handler({ data: "" });
        mocks.subscriptions[0].handler({});
        mocks.subscriptions[0].handler({ data: "block-2" });
        expect(removed).toEqual([["block-1"], ["block-2"]]);
    });
});

describe("ElectronThumbBackend degrades to nothing stored", () => {
    it("answers an empty store where the Electron API is missing", async () => {
        mocks.api = {};
        expect(await ElectronThumbBackend.read([{ key: "a", tag: "t" }])).toEqual({});
        expect(() =>
            ElectronThumbBackend.put({ key: "a", tag: "t", url: "x", width: 1, height: 1, at: 1 })
        ).not.toThrow();
        expect(() => ElectronThumbBackend.remove(["a"])).not.toThrow();
    });

    it("answers an empty store when the main process fails", async () => {
        mocks.api = {
            moltentermCarpetThumbRead: async () => {
                throw new Error("disk");
            },
            moltentermCarpetThumbPut: async () => {
                throw new Error("disk");
            },
        };
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        expect(await ElectronThumbBackend.read([{ key: "a", tag: "t" }])).toEqual({});
        ElectronThumbBackend.put({ key: "a", tag: "t", url: "x", width: 1, height: 1, at: 1 });
        for (let i = 0; i < 10; i++) {
            await Promise.resolve();
        }
        expect(log).toHaveBeenCalled();
        log.mockRestore();
    });

    it("asks nothing of the main process for no keys", async () => {
        const calls: string[] = [];
        mocks.api = {
            moltentermCarpetThumbRead: async () => calls.push("read"),
            moltentermCarpetThumbRemove: async () => calls.push("remove"),
        };
        expect(await ElectronThumbBackend.read([])).toEqual({});
        ElectronThumbBackend.remove([]);
        expect(calls).toEqual([]);
    });
});
