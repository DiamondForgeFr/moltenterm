// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { hostWheelTime } from "./view360/carpet-wheel";
import { gestureStepEvent, GestureSteps, initialGestureSteps } from "./wheel-gesture";

const StepPx = 24;

// Feeds deltas at 60 Hz (null: a frame without an event) and returns the steps taken, in order.
function steps(dxs: number[], start = 1000): number[] {
    let state: GestureSteps = initialGestureSteps();
    const out: number[] = [];
    dxs.forEach((dx, i) => {
        if (dx == null) {
            return;
        }
        const r = gestureStepEvent(state, { dx, at: start + i * 16 }, StepPx);
        state = r.state;
        if (r.step !== 0) {
            out.push(r.step);
        }
    });
    return out;
}

function decay(from: number, ratio: number): number[] {
    const out: number[] = [];
    for (let v = Math.abs(from) * ratio; Math.round(v) > 0; v *= ratio) {
        out.push(Math.sign(from) * Math.round(v));
    }
    return out;
}

const fingers = (pace: number, count = 10) => [Math.round(pace / 4), Math.round(pace / 2), ...Array(count).fill(pace)];

describe("one step per wheel gesture (#1466)", () => {
    it("steps once the travel passes the threshold, never on a resting trackpad's noise", () => {
        expect(steps([3, -2, 4, 2, -3, 1])).toEqual([]);
        expect(steps([10, 10, 10])).toEqual([1]);
        expect(steps([-30])).toEqual([-1]);
    });

    it("forgets a small travel after the fingers lifted", () => {
        expect(steps([12, ...Array(20).fill(null), 12])).toEqual([]);
    });

    it("steps once for a swipe whose momentum decays slowly, with no momentum signature for a while", () => {
        expect(steps([...fingers(20), ...decay(20, 0.985)])).toEqual([1]);
    });

    it("absorbs frames the busy main thread coalesced, even two in a row", () => {
        const tail = decay(30, 0.95);
        const coalesced = [...tail.slice(0, 15), tail[15] + tail[16], tail[17] + tail[18], ...tail.slice(19)];
        expect(steps([...fingers(30), ...coalesced])).toEqual([1]);
    });

    it("absorbs a finger lifting with a small reversal", () => {
        expect(steps([...fingers(20), -6, -3, ...decay(18, 0.95)])).toEqual([1]);
    });

    it("takes a reversal beyond the jitter, after the momentum shows, as a new gesture", () => {
        expect(steps([...fingers(20), ...decay(20, 0.95).slice(0, 20), -8, -14, -20])).toEqual([1, -1]);
    });

    it("takes fingers pushing again over the momentum as a new gesture", () => {
        expect(steps([...fingers(20), ...decay(20, 0.95).slice(0, 20), 6, 12, 18, 20, 20])).toEqual([1, 1]);
    });

    it("takes a pause in the momentum as the fingers touching again", () => {
        expect(steps([...fingers(20), ...decay(20, 0.95).slice(0, 10), null, null, null, null, 10, 20])).toEqual([
            1, 1,
        ]);
    });

    it("holds a slow stroke whose fingers pause between events: one step", () => {
        const slow = [6, null, null, null, null, null, null, 6, null, null, null, null, null, null];
        expect(steps([...slow, ...slow, ...slow, ...slow, ...slow, ...slow])).toEqual([1]);
    });
});

describe("a browser panel's wheel time on the host's clock (#1466)", () => {
    it("converts the guest's epoch time, never into the future", () => {
        expect(hostWheelTime({ delta: 1, deltaMode: 0, at: 5_000_100 }, 5_000_000, 200)).toBe(100);
        expect(hostWheelTime({ delta: 1, deltaMode: 0, at: 5_000_300 }, 5_000_000, 200)).toBe(200);
    });

    it("falls back to now without a time", () => {
        expect(hostWheelTime({ delta: 1, deltaMode: 0 }, 5_000_000, 200)).toBe(200);
        expect(hostWheelTime({ delta: 1, deltaMode: 0, at: Number.NaN }, 5_000_000, 200)).toBe(200);
    });
});
