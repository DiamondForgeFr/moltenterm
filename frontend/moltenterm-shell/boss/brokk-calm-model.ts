// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk under reduced motion (FR-BOSS-009, AC1, #2224): he stays animated whenever his face is visible, so the face plays
// the loop of its pose with slow blinks and nothing else: no gesture, no clip between two poses, nothing that crosses
// the picture. The rules of the blinks live here, pure and driven by the clock they are handed, so they are tested
// without a window; brokk-calm.tsx only plays the videos.
//
// The shared package cannot play this: it draws no clip at all while the system asks for reduced motion (it reads the
// media query by itself), and it plays every gesture and clip otherwise. This is the app's own player of the same clips.

import type { BrokkPose } from "./brokk-ask-model";
import { IdleGaps } from "./brokk-portrait";
import Manifest from "./portrait/brokk/brokk-manifest.json";

// A blink comes at the first end of a round of the loop once this long has passed since the last: the calm gap of
// brokk-portrait.ts, the slowest of the rhythms, whatever the scene says.
export const CalmBlinkGap = IdleGaps.calm;

// The pose's gestures drawn by chance are its blinks (the others are asked, which a calm face never does). Only the
// listening and the speaking poses have one.
export function hasBlink(pose: BrokkPose): boolean {
    const idles = (Manifest.idles as Record<string, { name: string }[]>)[pose] ?? [];
    return idles.some((idle) => idle.name === "blink");
}

// The names of the clips of a pose, as the package ships them (`<pose>.webm`, `<pose>.blink.webm`).
export function loopClipOf(pose: BrokkPose): string {
    return pose;
}

export function blinkClipOf(pose: BrokkPose): string {
    return `${pose}.blink`;
}

// A wait drawn within the calm gap; `random` is in [0, 1).
export function blinkGapMs(random: number): number {
    return Math.round(CalmBlinkGap.minMs + random * (CalmBlinkGap.maxMs - CalmBlinkGap.minMs));
}

export type CalmState = {
    // The earliest moment a blink may start.
    nextBlinkAt: number;
    // Where the loop was at the last reading: a position before it is a new round.
    lastTime: number;
    // A blink is under way or about to be.
    blinking: boolean;
    // The blink clip cannot play: no more are tried.
    broken: boolean;
};

export function startCalm(now: number, random: number): CalmState {
    return { nextBlinkAt: now + blinkGapMs(random), lastTime: 0, blinking: false, broken: false };
}

export type CalmEvent =
    // The loop's clock moved on: `at` is the time of day, `currentTime` the loop's position in seconds.
    | { type: "time"; at: number; currentTime: number; random: number }
    | { type: "blink-ended" }
    | { type: "blink-failed" };

export type CalmStep = {
    state: CalmState;
    // Start the blink clip now, at the loop's position.
    blink: boolean;
};

// A blink takes the place of a whole round, so it can only start where a round does: the clip starts and ends on the
// first frame of the loop, and a position that went back says the loop came round. The clip then begins at the loop's
// own position and the two end together.
export function calmAfter(state: CalmState, event: CalmEvent): CalmStep {
    switch (event.type) {
        case "time": {
            const wrapped = event.currentTime < state.lastTime;
            const next = { ...state, lastTime: event.currentTime };
            if (!wrapped || state.blinking || state.broken || event.at < state.nextBlinkAt) {
                return { state: next, blink: false };
            }
            return {
                state: { ...next, blinking: true, nextBlinkAt: event.at + blinkGapMs(event.random) },
                blink: true,
            };
        }
        case "blink-ended":
            return { state: { ...state, blinking: false }, blink: false };
        case "blink-failed":
            return { state: { ...state, blinking: false, broken: true }, blink: false };
        default:
            return { state, blink: false };
    }
}
