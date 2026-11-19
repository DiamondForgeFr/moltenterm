// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { makeSwitchIntent, SwitchIntentDwellMs } from "./switch-intent";

// A clock of the test: a timer fires only when the test advances it, so nothing here waits for real time.
function fakeClock() {
    let now = 0;
    let next = 1;
    const timers = new Map<number, { at: number; fn: () => void }>();
    return {
        schedule: (fn: () => void, ms: number) => {
            const id = next++;
            timers.set(id, { at: now + ms, fn });
            return id;
        },
        cancel: (handle: unknown) => {
            timers.delete(handle as number);
        },
        advance(ms: number) {
            now += ms;
            for (const [id, t] of Array.from(timers.entries())) {
                if (t.at <= now) {
                    timers.delete(id);
                    t.fn();
                }
            }
        },
    };
}

describe("the intent of a pointer on a workspace's dot (#2375)", () => {
    it("sends nothing while the pointer sweeps across the dots without resting on one", () => {
        const clock = fakeClock();
        const sent: string[] = [];
        const intent = makeSwitchIntent((id) => sent.push(id), clock);
        for (const id of ["a", "b", "c", "d", "e"]) {
            intent.enter(id);
            clock.advance(SwitchIntentDwellMs - 1);
        }
        expect(sent).toEqual([]);
    });

    it("sends the dot the pointer rests on, once, after the dwell", () => {
        const clock = fakeClock();
        const sent: string[] = [];
        const intent = makeSwitchIntent((id) => sent.push(id), clock);
        intent.enter("a");
        clock.advance(40);
        intent.enter("b");
        clock.advance(SwitchIntentDwellMs - 1);
        expect(sent).toEqual([]);
        clock.advance(1);
        expect(sent).toEqual(["b"]);
        clock.advance(10 * SwitchIntentDwellMs);
        expect(sent).toEqual(["b"]);
    });

    it("sends nothing for a pointer that left, or for a click that came first", () => {
        const clock = fakeClock();
        const sent: string[] = [];
        const intent = makeSwitchIntent((id) => sent.push(id), clock);
        intent.enter("a");
        intent.leave();
        clock.advance(10 * SwitchIntentDwellMs);
        expect(sent).toEqual([]);
        intent.leave();
        expect(sent).toEqual([]);
    });

    it("dwells for about a tenth of a second", () => {
        expect(SwitchIntentDwellMs).toBeGreaterThanOrEqual(80);
        expect(SwitchIntentDwellMs).toBeLessThanOrEqual(150);
    });
});
