// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/global", () => ({ getApi: () => null }));
vi.mock("../tab-activity", () => ({ TabActivity: { getInstance: () => ({ every: () => () => {} }) } }));

import { AwayAfterSec, AwayPollMs, Every, InputTarget, isAway, watchAway } from "./developer-away";

function target() {
    const listeners = new Map<string, Set<() => void>>();
    const t: InputTarget & { fire: (type: string) => void; count: () => number } = {
        addEventListener: (type, listener) => {
            if (!listeners.has(type)) {
                listeners.set(type, new Set());
            }
            listeners.get(type).add(listener);
        },
        removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
        fire: (type) => listeners.get(type)?.forEach((listener) => listener()),
        count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    };
    return t;
}

// A scheduler the test ticks by hand: no clock, no timer.
function ticker() {
    const jobs = new Set<() => void>();
    const periods: number[] = [];
    const every: Every = (ms, run) => {
        periods.push(ms);
        jobs.add(run);
        return () => jobs.delete(run);
    };
    return { every, periods, tick: () => jobs.forEach((run) => run()), size: () => jobs.size };
}

// The reading is a promise: let its answer arrive.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("away from this computer (FR-BOSS-007, AC2, #1958)", () => {
    it("is away after about ten minutes without input, not before", () => {
        expect(AwayAfterSec).toBe(600);
        expect(isAway(AwayAfterSec - 1)).toBe(false);
        expect(isAway(AwayAfterSec)).toBe(true);
        expect(isAway(null)).toBe(false);
    });

    it("reads the idle time at once and at each poll, and tells only the changes", async () => {
        let idle = 0;
        const changes: boolean[] = [];
        const clock = ticker();
        const stop = watchAway(
            target(),
            async () => idle,
            (away) => changes.push(away),
            clock.every
        );
        expect(clock.periods).toEqual([AwayPollMs]);
        await settle();
        expect(changes).toEqual([]);
        idle = AwayAfterSec + 5;
        clock.tick();
        await settle();
        expect(changes).toEqual([true]);
        clock.tick();
        await settle();
        expect(changes).toEqual([true]);
        idle = 1;
        clock.tick();
        await settle();
        expect(changes).toEqual([true, false]);
        stop();
    });

    it("wakes at once on an input in this page, without waiting for the next reading", async () => {
        const changes: boolean[] = [];
        const t = target();
        const stop = watchAway(
            t,
            async () => AwayAfterSec * 2,
            (away) => changes.push(away),
            ticker().every
        );
        await settle();
        expect(changes).toEqual([true]);
        t.fire("keydown");
        expect(changes).toEqual([true, false]);
        stop();
    });

    it("stops reading and listening once stopped, and says nothing after", async () => {
        const read = vi.fn(async () => AwayAfterSec * 2);
        const changes: boolean[] = [];
        const t = target();
        const clock = ticker();
        const stop = watchAway(t, read, (away) => changes.push(away), clock.every);
        stop();
        clock.tick();
        await settle();
        expect(read).toHaveBeenCalledTimes(1);
        expect(changes).toEqual([]);
        expect(t.count()).toBe(0);
        expect(clock.size()).toBe(0);
    });

    it("stays awake when the idle time cannot be read", async () => {
        const changes: boolean[] = [];
        const clock = ticker();
        const stop = watchAway(
            target(),
            async () => Promise.reject(new Error("no main")),
            (away) => changes.push(away),
            clock.every
        );
        clock.tick();
        await settle();
        expect(changes).toEqual([]);
        stop();
        const none = watchAway(target(), null, (away) => changes.push(away), clock.every);
        clock.tick();
        await settle();
        expect(changes).toEqual([]);
        none();
    });
});
