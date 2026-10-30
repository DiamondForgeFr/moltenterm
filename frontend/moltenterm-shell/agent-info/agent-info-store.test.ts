// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn(), onEvent: null as (() => void) | null }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: mocks.subscribe }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: mocks.call } }));
vi.mock("@/util/util", () => ({ fireAndForget: (fn: () => Promise<void>) => { void fn(); } }));

import { AgentInfoModel } from "./agent-info-store";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
    return { promise, resolve, reject };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const entry = { fromblockid: "a", toblockid: "b", goal: "handoff", at: 1 };

beforeEach(() => {
    vi.useFakeTimers();
    mocks.call.mockReset();
    mocks.subscribe.mockReset();
    mocks.onEvent = null;
    mocks.subscribe.mockImplementation(({ handler }) => { mocks.onEvent = handler; });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("handoff history refresh", () => {
    it("coalesces event bursts, discards a superseded read and publishes the follow-up snapshot", async () => {
        const first = deferred<any>();
        const second = deferred<any>();
        mocks.call.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const model = new (AgentInfoModel as any)() as AgentInfoModel;
        globalStore.set(model.historyAtom, [entry]);
        model.start();
        expect(mocks.onEvent).toBeTypeOf("function");
        for (let i = 0; i < 50; i++) mocks.onEvent!();
        expect(mocks.call).toHaveBeenCalledTimes(1);
        first.resolve({ entries: [] });
        await flush();
        expect(mocks.call).toHaveBeenCalledTimes(2);
        expect(globalStore.get(model.historyAtom)).toEqual([entry]);
        const newer = { ...entry, goal: "new handoff" };
        second.resolve({ entries: [entry, newer] });
        await flush();
        expect(globalStore.get(model.historyAtom)).toEqual([entry, newer]);
        expect(mocks.call).toHaveBeenCalledTimes(2);
    });

    it("keeps one retry chain, replaces a pending retry on an event and recovers after the retry limit", async () => {
        mocks.call.mockRejectedValue(new Error("route unavailable"));
        const model = new (AgentInfoModel as any)() as AgentInfoModel;
        model.start();
        await flush();
        expect(vi.getTimerCount()).toBe(1);
        mocks.onEvent!();
        await flush();
        expect(mocks.call).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(1);
        for (let i = 0; i < 9; i++) await vi.advanceTimersByTimeAsync(2000);
        expect(mocks.call).toHaveBeenCalledTimes(11);
        expect(vi.getTimerCount()).toBe(0);
        mocks.call.mockResolvedValueOnce({ entries: [entry] });
        mocks.onEvent!();
        await flush();
        expect(globalStore.get(model.historyAtom)).toEqual([entry]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("refreshes immediately after a failed read when an event arrived during it", async () => {
        const first = deferred<any>();
        mocks.call.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ entries: [entry] });
        const model = new (AgentInfoModel as any)() as AgentInfoModel;
        model.start();
        mocks.onEvent!();
        first.reject(new Error("route unavailable"));
        await flush();
        expect(mocks.call).toHaveBeenCalledTimes(2);
        expect(globalStore.get(model.historyAtom)).toEqual([entry]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("handles another change during the follow-up and permits a current empty response", async () => {
        const reads = [deferred<any>(), deferred<any>(), deferred<any>()];
        for (const read of reads) mocks.call.mockReturnValueOnce(read.promise);
        const model = new (AgentInfoModel as any)() as AgentInfoModel;
        globalStore.set(model.historyAtom, [entry]);
        model.start();
        model.start();
        expect(mocks.subscribe).toHaveBeenCalledTimes(1);
        mocks.onEvent!();
        reads[0].resolve({ entries: [] });
        await flush();
        mocks.onEvent!();
        reads[1].resolve({ entries: [{ ...entry, goal: "already superseded" }] });
        await flush();
        expect(globalStore.get(model.historyAtom)).toEqual([entry]);
        expect(mocks.call).toHaveBeenCalledTimes(3);
        reads[2].resolve(null);
        await flush();
        expect(globalStore.get(model.historyAtom)).toEqual([]);
    });
});
