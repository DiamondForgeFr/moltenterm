// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0
import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeepAwakeModel } from "./keepawake-store";

const m = vi.hoisted(() => ({
    rpc: vi.fn(),
    handler: null as () => void,
    unload: null as () => void,
    unsubscribe: vi.fn(),
}));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: ({ handler }: any) => {
        m.handler = handler;
        return m.unsubscribe;
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: m.rpc } }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("./notifications-store", () => ({ registerNotificationGesture: vi.fn() }));
vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));

beforeEach(() => {
    vi.useFakeTimers();
    m.rpc.mockReset();
    m.unsubscribe.mockReset();
    vi.stubGlobal("window", {
        addEventListener: (_: string, fn: () => void) => {
            m.unload = fn;
        },
    });
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("keep-awake indicator recovery", () => {
    it("recovers without another event and stops retries on unload", async () => {
        m.rpc
            .mockResolvedValueOnce({ version: 1, hold: false })
            .mockRejectedValueOnce(new Error("offline"))
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce({ version: 2, hold: true });
        const model = KeepAwakeModel.getInstance();
        await vi.advanceTimersByTimeAsync(0);
        m.handler();
        m.handler();
        await vi.advanceTimersByTimeAsync(50 + 2000 + 4000);
        expect(globalStore.get(model.stateAtom).hold).toBe(true);
        expect(m.rpc).toHaveBeenCalledTimes(4);
        m.rpc.mockRejectedValue(new Error("offline"));
        m.handler();
        await vi.advanceTimersByTimeAsync(50);
        m.unload();
        expect(m.unsubscribe).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });
});
