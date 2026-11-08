// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only
import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeepAwakeModel } from "./keepawake-store";

const m = vi.hoisted(() => ({
    rpc: vi.fn(),
    setConfig: vi.fn(),
    gestures: new Map<string, (args: any) => Promise<any>>(),
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
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetConfigCommand: m.setConfig } }));
vi.mock("./notifications-store", () => ({
    registerNotificationGesture: (name: string, fn: (args: any) => Promise<any>) => m.gestures.set(name, fn),
}));
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

// FR-SHELL-023 AC14, AC19 (#2089): Automatic is a setting, and the ask-once notification writes the settings that
// replaced the sleep policy.
describe("the two modes and the ask-once answers", () => {
    beforeEach(() => {
        m.setConfig.mockReset();
        m.setConfig.mockResolvedValue(undefined);
    });

    it("writes Automatic as its own setting, on and off", async () => {
        const model = KeepAwakeModel.getInstance();
        await model.setAutomatic(true);
        await model.setAutomatic(false);
        expect(m.setConfig.mock.calls.map((c) => c[1])).toEqual([
            { "power:automatic": true },
            { "power:automatic": false },
        ]);
    });

    it("answers the notification with the settings that replace the policy, and refuses an unknown answer", async () => {
        KeepAwakeModel.getInstance();
        const gesture = m.gestures.get("molten:sleeppolicy");
        expect(await gesture({ policy: "untilworkends" })).toMatchObject({ ok: true, resolve: true });
        expect(m.setConfig.mock.calls[0][1]).toEqual({ "power:automatic": true, "power:terminalrequests": "always" });
        await gesture({ policy: "letsleep" });
        expect(m.setConfig.mock.calls[1][1]).toEqual({ "power:terminalrequests": "never" });
        expect(await gesture({ policy: "sometimes" })).toMatchObject({ ok: false });
        expect(m.setConfig).toHaveBeenCalledTimes(2);
    });
});
