// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from "vitest";
import { KeepAwakeRefresh } from "./keepawake-refresh";

afterEach(() => vi.useRealTimers());

it("keeps the retry delay when events arrive during a failing read", async () => {
    vi.useFakeTimers();
    let reject: (reason: Error) => void;
    const read = vi
        .fn()
        .mockImplementationOnce(
            () =>
                new Promise((_resolve, r) => {
                    reject = r;
                })
        )
        .mockResolvedValue({ version: 1 });
    const refresh = new KeepAwakeRefresh(read, vi.fn());
    refresh.request();
    refresh.request();
    refresh.request();
    reject(new Error("offline"));
    await vi.advanceTimersByTimeAsync(1999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    refresh.stop();
});

it("backs off to a 30 second ceiling, coalesces events and stops without polling when healthy", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(new Error("offline"));
    const apply = vi.fn();
    const refresh = new KeepAwakeRefresh(read, apply);
    refresh.request();
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
        refresh.request();
        refresh.request();
        const count = read.mock.calls.length;
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(read).toHaveBeenCalledTimes(count);
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(count + 1);
    }
    read.mockResolvedValue({ version: 1 });
    await vi.advanceTimersByTimeAsync(30000);
    expect(apply).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    refresh.stop();
});
