// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SliderWrites } from "./slider-writes";

function deferred() {
    let resolve: () => void;
    let reject: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function fixture(persist = vi.fn(async (_value: number | null) => {})) {
    const failure = vi.fn();
    const clearFailure = vi.fn();
    return { writes: new SliderWrites(persist, failure, clearFailure), persist, failure, clearFailure };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Settings slider persistence (#818)", () => {
    it("saves 0.7 after 0.3 → 10 ms → 0.7 → unmount, with one final write", async () => {
        const { writes, persist } = fixture();
        const unmount = writes.subscribe(() => {});
        writes.select(0.3);
        await vi.advanceTimersByTimeAsync(10);
        writes.select(0.7);
        writes.flush(); // gesture end
        writes.flush(); // blur
        unmount();
        writes.flush(); // cleanup
        await vi.runAllTimersAsync();
        expect(persist.mock.calls).toEqual([[0.3], [0.7]]);
        writes.observe(0.7);
        expect(writes.state.intent).toBeNull();
    });

    it("bounds continuous pointer or keyboard writes and coalesces to the latest choice", async () => {
        const starts: number[] = [];
        const { writes, persist } = fixture(
            vi.fn(async () => {
                starts.push(Date.now());
            })
        );
        for (let i = 0; i <= 100; i++) {
            writes.select(i);
            writes.flush(); // keyup is idempotent and cannot bypass the rate bound
            await vi.advanceTimersByTimeAsync(1);
        }
        writes.flush();
        await vi.runAllTimersAsync();
        expect(persist.mock.calls.at(-1)).toEqual([100]);
        expect(starts.length).toBeLessThanOrEqual(3);
        expect(starts.slice(1).every((time, index) => time - starts[index] >= 60)).toBe(true);
    });

    it("serializes a pending request across unmount/remount and orders Reset after it", async () => {
        const first = deferred();
        const { writes, persist } = fixture(
            vi
                .fn()
                .mockImplementationOnce(() => first.promise)
                .mockResolvedValue(null)
        );
        writes.select(0.3);
        await vi.advanceTimersByTimeAsync(10);
        writes.select(0.7);
        writes.flush();
        await vi.advanceTimersByTimeAsync(500);
        expect(persist.mock.calls).toEqual([[0.3]]);
        const unsub = writes.subscribe(() => {}); // the new control shares the same key's owner
        writes.observe(0.1);
        expect(writes.state.intent.value).toBe(0.7);
        first.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(persist.mock.calls).toEqual([[0.3], [0.7]]);
        writes.select(null);
        unsub();
        writes.flush();
        await vi.runAllTimersAsync();
        expect(persist.mock.calls).toEqual([[0.3], [0.7], [null]]);
    });

    it("does not let an earlier completion clear a newer draft or a delayed prop revert it", async () => {
        const first = deferred();
        const second = deferred();
        const { writes } = fixture(vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
        writes.observe(0.1);
        writes.select(0.3);
        writes.select(0.7);
        first.resolve();
        await vi.advanceTimersByTimeAsync(60);
        expect(writes.state.intent.value).toBe(0.7);
        second.resolve();
        await vi.advanceTimersByTimeAsync(0);
        writes.observe(0.3);
        expect(writes.state.intent.value).toBe(0.7);
        writes.observe(0.7);
        expect(writes.state.intent).toBeNull();
    });

    it("keeps a failed final intent retryable after unmount without an automatic retry loop", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const request = deferred();
        const { writes, persist, failure } = fixture(
            vi.fn().mockReturnValueOnce(request.promise).mockResolvedValue(null)
        );
        const listener = vi.fn();
        const unmount = writes.subscribe(listener);
        writes.select(0.7);
        unmount();
        listener.mockClear();
        request.reject(new Error("offline"));
        await vi.runAllTimersAsync();
        expect(listener).not.toHaveBeenCalled();
        expect(writes.state.failed).toBe(true);
        expect(writes.state.intent.value).toBe(0.7);
        expect(failure).toHaveBeenCalledOnce();
        expect(persist).toHaveBeenCalledOnce();
        failure.mock.calls[0][0]();
        await vi.runAllTimersAsync();
        expect(persist.mock.calls).toEqual([[0.7], [0.7]]);
        expect(writes.state.failed).toBe(false);
        vi.restoreAllMocks();
    });

    it("supersedes a failed request with the newest intent and keeps keys independent", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const first = deferred();
        const a = fixture(vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(null));
        const b = fixture();
        a.writes.select(0.3);
        a.writes.select(0.7);
        b.writes.select(15);
        first.reject(new Error("old request failed"));
        await vi.runAllTimersAsync();
        expect(a.persist.mock.calls).toEqual([[0.3], [0.7]]);
        expect(a.failure).not.toHaveBeenCalled();
        expect(b.persist.mock.calls).toEqual([[15]]);
        vi.restoreAllMocks();
    });
});
