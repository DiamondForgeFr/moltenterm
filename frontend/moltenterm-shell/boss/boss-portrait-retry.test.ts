// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { LiveRetry, retryDelayMs, RetryDelaysMs, StableAfterMs } from "./boss-portrait-retry";

// A clock the test drives by hand: nothing here waits.
function makeClock() {
    let now = 0;
    let next = 0;
    const timers = new Map<number, { at: number; run: () => void }>();
    return {
        setTimer: (run: () => void, ms: number) => {
            next++;
            timers.set(next, { at: now + ms, run });
            return next;
        },
        clearTimer: (timer: unknown) => {
            timers.delete(timer as number);
        },
        pending: () => timers.size,
        advance(ms: number) {
            const until = now + ms;
            for (;;) {
                const due = [...timers.entries()]
                    .filter(([, timer]) => timer.at <= until)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (due == null) {
                    break;
                }
                timers.delete(due[0]);
                now = due[1].at;
                due[1].run();
            }
            now = until;
        },
    };
}

function makeRetry(clock: ReturnType<typeof makeClock>, onRetry: () => void = () => {}) {
    return new LiveRetry({ setTimer: clock.setTimer, clearTimer: clock.clearTimer, retry: onRetry });
}

describe("the pause before the live portrait is tried again (FR-BOSS-009, AC1, #2219)", () => {
    it("starts short, grows, and stays at the last pause", () => {
        expect(retryDelayMs(1)).toBe(RetryDelaysMs[0]);
        expect(retryDelayMs(2)).toBe(RetryDelaysMs[1]);
        expect(retryDelayMs(3)).toBe(RetryDelaysMs[2]);
        expect(retryDelayMs(50)).toBe(RetryDelaysMs[RetryDelaysMs.length - 1]);
        expect(retryDelayMs(0)).toBe(RetryDelaysMs[0]);
        expect([...RetryDelaysMs].sort((a, b) => a - b)).toEqual([...RetryDelaysMs]);
    });
});

describe("a live portrait that failed (AC-3)", () => {
    it("is tried again after the first pause, and not before", () => {
        const clock = makeClock();
        let retries = 0;
        const retry = makeRetry(clock, () => retries++);
        retry.failed();
        clock.advance(RetryDelaysMs[0] - 1);
        expect(retries).toBe(0);
        clock.advance(1);
        expect(retries).toBe(1);
    });

    it("waits longer each time it fails again, up to the last pause, and never gives up", () => {
        const clock = makeClock();
        let retries = 0;
        const retry = makeRetry(clock, () => retries++);
        const waited: number[] = [];
        for (let failure = 1; failure <= 5; failure++) {
            retry.failed();
            const before = retries;
            let ms = 0;
            while (retries === before) {
                clock.advance(1000);
                ms += 1000;
            }
            waited.push(ms);
        }
        expect(waited).toEqual([2000, 10000, 60000, 60000, 60000]);
        expect(retries).toBe(5);
    });

    it("recovers: the portrait that failed twice and then loads is drawn, and nothing is tried after it", () => {
        const clock = makeClock();
        let loads = 0;
        let drawn = false;
        const retry = makeRetry(clock, () => {
            loads++;
            if (loads <= 2) {
                retry.failed();
                return;
            }
            drawn = true;
        });
        retry.failed();
        clock.advance(RetryDelaysMs[0] + RetryDelaysMs[1] + RetryDelaysMs[2]);
        expect(drawn).toBe(true);
        expect(loads).toBe(3);
        clock.advance(10 * StableAfterMs);
        expect(loads).toBe(3);
    });

    it("keeps one retry waiting at a time: a new failure replaces the one that was waiting", () => {
        const clock = makeClock();
        let retries = 0;
        const retry = makeRetry(clock, () => retries++);
        retry.failed();
        retry.failed();
        expect(clock.pending()).toBe(1);
        clock.advance(RetryDelaysMs[1]);
        expect(retries).toBe(1);
    });

    it("starts again from the short pause once a retry has held for a while", () => {
        const clock = makeClock();
        let retries = 0;
        const retry = makeRetry(clock, () => retries++);
        retry.failed();
        clock.advance(RetryDelaysMs[0]);
        retry.failed();
        clock.advance(RetryDelaysMs[1]);
        expect(retries).toBe(2);
        clock.advance(StableAfterMs);
        expect(retry.failures).toBe(0);
        retry.failed();
        clock.advance(RetryDelaysMs[0]);
        expect(retries).toBe(3);
    });

    it("does not start again from the short pause when it fails again before it has held", () => {
        const clock = makeClock();
        let retries = 0;
        const retry = makeRetry(clock, () => retries++);
        retry.failed();
        clock.advance(RetryDelaysMs[0]);
        clock.advance(StableAfterMs - 1);
        retry.failed();
        expect(retry.failures).toBe(2);
        clock.advance(RetryDelaysMs[0]);
        expect(retries).toBe(1);
        clock.advance(RetryDelaysMs[1]);
        expect(retries).toBe(2);
    });

    it("is not tried again for a face that left the page", () => {
        const clock = makeClock();
        let retries = 0;
        const retry = makeRetry(clock, () => retries++);
        retry.failed();
        retry.cancel();
        expect(clock.pending()).toBe(0);
        clock.advance(10 * RetryDelaysMs[2]);
        expect(retries).toBe(0);
    });

    it("clears the wait for a retry to hold when the face leaves the page", () => {
        const clock = makeClock();
        const retry = makeRetry(clock);
        retry.failed();
        clock.advance(RetryDelaysMs[0]);
        expect(clock.pending()).toBe(1);
        retry.cancel();
        expect(clock.pending()).toBe(0);
    });
});
