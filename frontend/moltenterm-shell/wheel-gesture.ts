// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A trackpad gesture read from its wheel events, shared by the sidebar's swipe (FR-SHELL-082, sidebar/sidebar-swipe.ts)
// and the 360 carpet's whole-panel steps (FR-SHELL-123, #1466). Chromium's wheel events carry no phase (Electron's
// scroll-touch-begin/end were removed in Electron 23, and on macOS the momentum stays in the finger's scroll
// sequence), so the phases come from the deltas themselves: the momentum sends an event every frame, never reverses
// and only decays.

// No wheel event for this long: the fingers lifted. Shorter pauses belong to the stroke: slow fingers leave 100 to
// 150 ms between events (#1312).
export const StrokeGapMs = 250;
// A wheel event after a pause this long is a fresh touch: momentum events come every frame.
export const FreshTouchGapMs = 60;
// The momentum's signature: this many deltas in a row, none larger than the one before nor much smaller, and the
// last at most MomentumMaxRatio of the first.
export const MomentumRun = 4;
export const MomentumMinRatio = 0.6;
export const MomentumMaxRatio = 0.9;
// Within the momentum, a delta this small the other way is noise (fingers lifting, rounding), not a new gesture.
export const MomentumJitterPx = 4;
// This many deltas in a row above the momentum's level are fingers pushing again. One alone is a frame the busy main
// thread coalesced into the next (its deltas add up), which the carpet's own glide can cause.
export const FreshRiseRun = 3;
// Fingers slowed under this share of their fastest delta have let go, momentum or not.
const DecayedShare = 0.25;
const SpentSamples = 8;

export type WheelSample = { dx: number; at: number };

// The momentum's signature at the end of the samples: deltas of one sign, each smaller than the one before by a
// smooth ratio.
export function looksLikeMomentum(samples: readonly WheelSample[]): boolean {
    if (samples.length < MomentumRun) {
        return false;
    }
    const run = samples.slice(-MomentumRun);
    const sign = Math.sign(run[0].dx);
    if (sign === 0 || Math.abs(run[0].dx) < 4) {
        return false;
    }
    for (let i = 1; i < run.length; i++) {
        if (Math.sign(run[i].dx) !== sign) {
            return false;
        }
        // Rounded deltas may repeat a value; they never grow.
        const ratio = Math.abs(run[i].dx) / Math.abs(run[i - 1].dx);
        if (ratio < MomentumMinRatio || ratio > 1) {
            return false;
        }
    }
    return Math.abs(run[run.length - 1].dx) / Math.abs(run[0].dx) <= MomentumMaxRatio;
}

// ---- one step per gesture -----------------------------------------------------------------------------------------

// The rest of a gesture that already stepped. While the fingers may still be on the trackpad (momentum 0) everything
// belongs to it until a StrokeGapMs pause. Once its momentum shows, a fresh touch ends it: a FreshTouchGapMs pause, a
// reversal beyond the jitter, or FreshRiseRun deltas in a row rising above the momentum's level.
export type SpentGesture = {
    sign: number;
    peak: number;
    samples: WheelSample[];
    // The momentum's level once it shows, 0 before.
    momentum: number;
    rise: number;
    riseTravel: number;
};

export type GestureSteps = {
    // Travel toward a step, while the gesture has not stepped.
    acc: number;
    lastAt: number;
    spent: SpentGesture;
};

export function initialGestureSteps(): GestureSteps {
    return { acc: 0, lastAt: -Infinity, spent: null };
}

// One wheel event through a machine that steps once per gesture: a step once the gesture's travel passes stepPx, then
// nothing until the fingers lift and touch again, whatever the momentum's length, small reversals or speed (#1466).
export function gestureStepEvent(
    state: GestureSteps,
    ev: WheelSample,
    stepPx: number
): { state: GestureSteps; step: -1 | 0 | 1 } {
    const gap = ev.at - state.lastAt;
    if (state.spent == null) {
        return accumulate(gap > StrokeGapMs ? ev.dx : state.acc + ev.dx, ev, stepPx);
    }
    const read = readSpent(state.spent, ev, gap);
    if (read.spent != null) {
        return { state: { acc: 0, lastAt: ev.at, spent: read.spent }, step: 0 };
    }
    return accumulate(read.fresh, ev, stepPx);
}

function accumulate(acc: number, ev: WheelSample, stepPx: number): { state: GestureSteps; step: -1 | 0 | 1 } {
    if (Math.abs(acc) < stepPx) {
        return { state: { acc, lastAt: ev.at, spent: null }, step: 0 };
    }
    const sign = Math.sign(acc) as -1 | 1;
    const spent: SpentGesture = {
        sign,
        peak: Math.abs(ev.dx),
        samples: [ev],
        momentum: 0,
        rise: 0,
        riseTravel: 0,
    };
    return { state: { acc: 0, lastAt: ev.at, spent }, step: sign };
}

// The event either continues the spent gesture (spent) or is a fresh touch carrying the travel that told it (fresh).
function readSpent(spent: SpentGesture, ev: WheelSample, gap: number): { spent?: SpentGesture; fresh?: number } {
    const lifted = spent.momentum > 0;
    if (gap > (lifted ? FreshTouchGapMs : StrokeGapMs)) {
        return { fresh: ev.dx };
    }
    const abs = Math.abs(ev.dx);
    const along = Math.sign(ev.dx) === spent.sign;
    if (!lifted) {
        const samples = [...spent.samples, ev].slice(-SpentSamples);
        const peak = along ? Math.max(spent.peak, abs) : spent.peak;
        const letGo = along && (looksLikeMomentum(samples) || abs <= peak * DecayedShare);
        return { spent: { ...spent, peak, samples, momentum: letGo ? Math.max(1, abs) : 0 } };
    }
    if (!along && ev.dx !== 0) {
        return abs <= MomentumJitterPx ? { spent: { ...spent, rise: 0, riseTravel: 0 } } : { fresh: ev.dx };
    }
    // Rounded deltas may repeat or round up by a pixel.
    if (abs <= spent.momentum * 1.15 + 1) {
        return { spent: { ...spent, momentum: Math.max(1, Math.min(spent.momentum, abs)), rise: 0, riseTravel: 0 } };
    }
    const rise = spent.rise + 1;
    const riseTravel = spent.riseTravel + ev.dx;
    if (rise >= FreshRiseRun) {
        return { fresh: riseTravel };
    }
    return { spent: { ...spent, rise, riseTravel } };
}
