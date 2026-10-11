// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { declaresTimerName, MoltenModTimers, MoltenTimerClock, timerPrologue } from "./molten-timers";

const Clock: MoltenTimerClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

function makeTimers() {
    const counts: number[] = [];
    const timers = new MoltenModTimers(
        Clock,
        (fn) => fn(),
        (n) => counts.push(n)
    );
    return { timers, counts, api: timers.api() };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("MoltenModTimers", () => {
    it("runs intervals and timeouts and counts the live ones", () => {
        const { timers, api } = makeTimers();
        const tick = vi.fn();
        const once = vi.fn();
        api.setInterval(tick, 1000);
        api.setTimeout(once, 500, "a", 1);
        expect(timers.count()).toBe(2);
        vi.advanceTimersByTime(3000);
        expect(tick).toHaveBeenCalledTimes(3);
        expect(once).toHaveBeenCalledExactlyOnceWith("a", 1);
        expect(timers.count()).toBe(1);
    });

    it("holds every timer while paused and runs an overdue one once on resume (FR-PERF-014)", () => {
        const { timers, api } = makeTimers();
        const tick = vi.fn();
        const later = vi.fn();
        api.setInterval(tick, 1000);
        api.setTimeout(later, 2500);
        vi.advanceTimersByTime(1000);
        expect(tick).toHaveBeenCalledTimes(1);

        timers.pause();
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(10000);
        expect(tick).toHaveBeenCalledTimes(1);
        expect(later).not.toHaveBeenCalled();

        timers.resume();
        vi.advanceTimersByTime(0);
        expect(tick).toHaveBeenCalledTimes(2);
        expect(later).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1000);
        expect(tick).toHaveBeenCalledTimes(3);
    });

    it("lets a callback clear its own interval", () => {
        const { timers, api } = makeTimers();
        let runs = 0;
        const handle = api.setInterval(() => {
            runs++;
            if (runs === 2) {
                api.clearInterval(handle);
            }
        }, 100);
        vi.advanceTimersByTime(1000);
        expect(runs).toBe(2);
        expect(timers.count()).toBe(0);
    });

    it("stops every timer when disposed and refuses new ones", () => {
        const { timers, api, counts } = makeTimers();
        const tick = vi.fn();
        api.setInterval(tick, 100);
        timers.dispose();
        vi.advanceTimersByTime(1000);
        expect(tick).not.toHaveBeenCalled();
        expect(api.setTimeout(tick, 10)).toBe(0);
        expect(counts.at(-1)).toBe(0);
    });

    it("clears the browser's own handles through the shadowed functions", () => {
        const { api } = makeTimers();
        const fn = vi.fn();
        const handle = globalThis.setTimeout(fn, 100);
        api.clearTimeout(handle);
        vi.advanceTimersByTime(200);
        expect(fn).not.toHaveBeenCalled();
    });

    it("never spins on an interval of 0", () => {
        const { api } = makeTimers();
        const tick = vi.fn();
        api.setInterval(tick, 0);
        vi.advanceTimersByTime(10);
        expect(tick.mock.calls.length).toBeLessThanOrEqual(10);
    });
});

describe("timer shadowing", () => {
    it("detects a module that declares a timer name itself", () => {
        expect(declaresTimerName("export function activate(api) { setInterval(() => {}, 10); }")).toBe(false);
        expect(declaresTimerName("const t = setTimeout(f, 1);")).toBe(false);
        expect(declaresTimerName("function setTimeout(fn) {}")).toBe(true);
        expect(declaresTimerName("const { setInterval } = window;")).toBe(true);
        expect(declaresTimerName("let a, clearTimeout;")).toBe(true);
    });

    it("writes a one-line prologue", () => {
        const prologue = timerPrologue("__reg", "mod#1");
        expect(prologue).not.toContain("\n");
        expect(prologue).toBe(
            'const {setTimeout,setInterval,clearTimeout,clearInterval}=globalThis.__reg.get("mod#1");'
        );
    });
});
