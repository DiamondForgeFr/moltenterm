// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The machine's load for the popover's strip (#2502): the strip shows for a loaded reading only, the reading is asked
// while the popover shows and never before or after, and an ask that fails changes nothing.

import { describe, expect, it, vi } from "vitest";
import type { MachineLoad } from "../agent-state-model";
import { LoadPollMs, showsLoadWarning, watchMachineLoad } from "./activity-load";

describe("when the strip shows", () => {
    it("shows for a known loaded reading, and never for an unknown, an unloaded or a missing one", () => {
        expect(showsLoadWarning({ known: true, loaded: true, percore: 8 })).toBe(true);
        expect(showsLoadWarning({ known: true, loaded: false, percore: 1.5 })).toBe(false);
        expect(showsLoadWarning({ known: false, loaded: true })).toBe(false);
        expect(showsLoadWarning(null)).toBe(false);
        expect(showsLoadWarning(undefined)).toBe(false);
    });
});

// A timer of the test's own: what was asked is run when the test says, so nothing waits for a clock.
function fakeTimer() {
    const pending: { id: number; fn: () => void; ms: number }[] = [];
    let next = 0;
    return {
        pending,
        set: (fn: () => void, ms: number) => {
            const id = ++next;
            pending.push({ id, fn, ms });
            return id;
        },
        clear: (timer: unknown) => {
            const i = pending.findIndex((p) => p.id === timer);
            if (i >= 0) {
                pending.splice(i, 1);
            }
        },
        fire: async () => {
            const [first] = pending.splice(0, 1);
            first.fn();
            await Promise.resolve();
            await Promise.resolve();
        },
    };
}

async function settle() {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}

describe("asking while the popover shows", () => {
    it("asks at once, then again every few seconds after each answer, and stops when told to", async () => {
        const timer = fakeTimer();
        const got: MachineLoad[] = [];
        let asks = 0;
        const stop = watchMachineLoad({
            read: async () => ({ known: true, loaded: ++asks >= 2 }),
            onLoad: (load) => got.push(load),
            setTimer: timer.set,
            clearTimer: timer.clear,
        });
        await settle();
        expect(asks).toBe(1);
        expect(got).toEqual([{ known: true, loaded: false }]);
        expect(timer.pending).toHaveLength(1);
        expect(timer.pending[0].ms).toBe(LoadPollMs);

        await timer.fire();
        await settle();
        expect(got.map((g) => g.loaded)).toEqual([false, true]);
        expect(timer.pending).toHaveLength(1);

        stop();
        expect(timer.pending).toHaveLength(0);
        expect(asks).toBe(2);
    });

    it("asks nothing more once stopped, even for an answer still on its way", async () => {
        const timer = fakeTimer();
        const got: MachineLoad[] = [];
        let answer: (load: MachineLoad) => void = () => {};
        const stop = watchMachineLoad({
            read: () => new Promise<MachineLoad>((resolve) => (answer = resolve)),
            onLoad: (load) => got.push(load),
            setTimer: timer.set,
            clearTimer: timer.clear,
        });
        stop();
        answer({ known: true, loaded: true });
        await settle();
        expect(got).toEqual([]);
        expect(timer.pending).toHaveLength(0);
    });

    it("keeps the last reading and tries again later when an ask fails", async () => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        const timer = fakeTimer();
        const got: MachineLoad[] = [];
        let asks = 0;
        const stop = watchMachineLoad({
            read: async () => {
                asks++;
                if (asks === 1) {
                    throw new Error("the route did not answer");
                }
                return { known: true, loaded: true };
            },
            onLoad: (load) => got.push(load),
            setTimer: timer.set,
            clearTimer: timer.clear,
        });
        await settle();
        expect(got).toEqual([]);
        expect(timer.pending).toHaveLength(1);
        await timer.fire();
        await settle();
        expect(got).toEqual([{ known: true, loaded: true }]);
        stop();
    });
});
