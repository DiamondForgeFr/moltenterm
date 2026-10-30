// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./moltenterm-keepawake";

const m = vi.hoisted(() => ({
    rpc: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    held: false,
    event: null as () => void,
    quit: null as () => void,
    unsubscribe: vi.fn(),
}));
vi.mock("electron", () => ({
    app: {
        on: (_: string, f: () => void) => {
            m.quit = f;
        },
    },
    powerSaveBlocker: {
        start: () => {
            m.held = true;
            m.start();
            return 1;
        },
        stop: () => {
            m.held = false;
            m.stop();
        },
        isStarted: () => m.held,
    },
}));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: ({ handler }: any) => {
        m.event = handler;
        return m.unsubscribe;
    },
}));
vi.mock("./emain-wsh", () => ({ ElectronWshClient: { wshRpcCall: m.rpc } }));

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    m.rpc.mockReset();
    m.start.mockReset();
    m.stop.mockReset();
    m.unsubscribe.mockReset();
    m.held = false;
});
afterEach(() => {
    vi.useRealTimers();
});

describe("keep-awake recovery", () => {
    it("recovers after repeated failures, coalesces events, and releases the blocker", async () => {
        m.rpc
            .mockResolvedValueOnce({ version: 1, hold: false })
            .mockRejectedValueOnce(new Error("offline"))
            .mockRejectedValueOnce(new Error("offline"))
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce({ version: 2, hold: true })
            .mockResolvedValueOnce({ version: 1, hold: false })
            .mockResolvedValueOnce({ version: 3, hold: false });
        const { initMoltentermKeepAwake } = await import("./moltenterm-keepawake");
        initMoltentermKeepAwake();
        await vi.advanceTimersByTimeAsync(0);
        m.event();
        m.event();
        m.event();
        await vi.advanceTimersByTimeAsync(0);
        expect(m.rpc).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000);
        expect(m.start).toHaveBeenCalledTimes(1);
        expect(m.held).toBe(true);
        m.event();
        await vi.advanceTimersByTimeAsync(0);
        expect(m.held).toBe(true);
        m.event();
        await vi.advanceTimersByTimeAsync(0);
        expect(m.held).toBe(false);
        expect(m.stop).toHaveBeenCalledTimes(1);
        m.quit();
        expect(m.unsubscribe).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not apply a late response after quit", async () => {
        let resolve: (v: any) => void;
        m.rpc.mockImplementation(
            () =>
                new Promise((r) => {
                    resolve = r;
                })
        );
        const { initMoltentermKeepAwake } = await import("./moltenterm-keepawake");
        initMoltentermKeepAwake();
        m.quit();
        resolve({ version: 1, hold: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(m.start).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("serializes events while a read is in flight and rereads after it", async () => {
        let resolve: (v: any) => void;
        m.rpc
            .mockImplementationOnce(
                () =>
                    new Promise((r) => {
                        resolve = r;
                    })
            )
            .mockResolvedValueOnce({ version: 2, hold: true });
        const { initMoltentermKeepAwake } = await import("./moltenterm-keepawake");
        initMoltentermKeepAwake();
        m.event();
        m.event();
        m.event();
        expect(m.rpc).toHaveBeenCalledTimes(1);
        resolve({ version: 1, hold: false });
        await vi.advanceTimersByTimeAsync(0);
        expect(m.rpc).toHaveBeenCalledTimes(2);
        expect(m.start).toHaveBeenCalledOnce();
        m.quit();
    });
});
