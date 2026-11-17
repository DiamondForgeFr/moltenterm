// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BrokkPose } from "./brokk-ask-model";
import {
    blinkClipOf,
    blinkGapMs,
    calmAfter,
    CalmBlinkGap,
    CalmState,
    hasBlink,
    loopClipOf,
    startCalm,
} from "./brokk-calm-model";
import { IdleGaps } from "./brokk-portrait";

const Folder = join(__dirname, "portrait", "brokk");
const Poses: BrokkPose[] = ["listening", "thinking", "speaking", "rest"];
const T = 1_000_000;

// The loop's position moves forward by ticks and goes back to the start when it comes round.
function time(state: CalmState, at: number, currentTime: number, random: number = 0) {
    return calmAfter(state, { type: "time", at, currentTime, random });
}

describe("how slowly he blinks under reduced motion (FR-BOSS-009, AC1, #2224)", () => {
    it("waits at least the slowest of the rhythms between two blinks, and at most its longest wait", () => {
        expect(CalmBlinkGap).toBe(IdleGaps.calm);
        expect(blinkGapMs(0)).toBe(IdleGaps.calm.minMs);
        expect(blinkGapMs(0.999999)).toBeLessThanOrEqual(IdleGaps.calm.maxMs);
        expect(blinkGapMs(0.5)).toBeGreaterThan(IdleGaps.calm.minMs);
        expect(IdleGaps.calm.minMs).toBeGreaterThan(IdleGaps.normal.minMs);
    });

    it("blinks in the listening and speaking poses only, which are the ones with a blink clip", () => {
        expect(Poses.filter(hasBlink)).toEqual(["listening", "speaking"]);
    });

    it("names the clips the package ships, and every one of them exists", () => {
        for (const pose of Poses) {
            expect(loopClipOf(pose)).toBe(pose);
            expect(existsSync(join(Folder, `${loopClipOf(pose)}.webm`)), pose).toBe(true);
            if (hasBlink(pose)) {
                expect(blinkClipOf(pose)).toBe(`${pose}.blink`);
                expect(existsSync(join(Folder, `${blinkClipOf(pose)}.webm`)), pose).toBe(true);
            }
        }
    });

    it("plays no gesture and no clip between two poses: the only clips it names are the loops and the blinks", () => {
        const names = Poses.flatMap((pose) => [loopClipOf(pose), ...(hasBlink(pose) ? [blinkClipOf(pose)] : [])]);
        expect(names.some((name) => name.includes("-to-"))).toBe(false);
        expect(names.filter((name) => name.includes("."))).toEqual(["listening.blink", "speaking.blink"]);
    });
});

describe("when the blink starts", () => {
    const start = startCalm(T, 0);

    it("is not at the start: the first blink waits for its gap too", () => {
        expect(start.nextBlinkAt).toBe(T + IdleGaps.calm.minMs);
        expect(start.blinking).toBe(false);
    });

    it("waits for the gap, even where the loop comes round", () => {
        const state = time(start, T + 1000, 4.4).state;
        const step = time(state, T + 2000, 0.1);
        expect(step.blink).toBe(false);
        expect(step.state.blinking).toBe(false);
    });

    it("waits for the loop to come round once the gap has passed: never in the middle of a round", () => {
        let state = time(start, T + IdleGaps.calm.minMs + 1000, 1.0).state;
        for (const position of [1.25, 1.5, 2.0, 3.5, 4.4]) {
            const step = time(state, T + IdleGaps.calm.minMs + 2000, position);
            expect(step.blink, String(position)).toBe(false);
            state = step.state;
        }
        const step = time(state, T + IdleGaps.calm.minMs + 3000, 0.2);
        expect(step.blink).toBe(true);
        expect(step.state.blinking).toBe(true);
    });

    it("draws the next wait from the start of the blink, within the calm gap", () => {
        const at = T + IdleGaps.calm.minMs + 3000;
        const before = time(start, at - 100, 4.4).state;
        const step = time(before, at, 0.2, 0.5);
        expect(step.blink).toBe(true);
        expect(step.state.nextBlinkAt).toBe(at + blinkGapMs(0.5));
        expect(step.state.nextBlinkAt - at).toBeGreaterThanOrEqual(IdleGaps.calm.minMs);
        expect(step.state.nextBlinkAt - at).toBeLessThanOrEqual(IdleGaps.calm.maxMs);
    });

    it("starts no second blink while one plays, whatever the clock says", () => {
        const at = T + IdleGaps.calm.minMs + 3000;
        const playing = time(time(start, at - 100, 4.4).state, at, 0.2).state;
        const later = { ...playing, nextBlinkAt: 0 };
        const step = time(time(later, at + 4000, 4.4).state, at + 4500, 0.1);
        expect(step.blink).toBe(false);
    });

    it("blinks again after one has ended, once its gap has passed and the loop comes round", () => {
        const at = T + IdleGaps.calm.minMs + 3000;
        const playing = time(time(start, at - 100, 4.4).state, at, 0.2).state;
        const ended = calmAfter(playing, { type: "blink-ended" }).state;
        expect(ended.blinking).toBe(false);
        expect(time(time(ended, at + 5000, 4.4).state, at + 5500, 0.1).blink).toBe(false);
        const due = playing.nextBlinkAt + 100;
        expect(time(time(ended, due - 100, 4.4).state, due, 0.1).blink).toBe(true);
    });

    it("stops blinking for good when the blink clip cannot play, and leaves the loop alone", () => {
        const at = T + IdleGaps.calm.minMs + 3000;
        const playing = time(time(start, at - 100, 4.4).state, at, 0.2).state;
        const broken = calmAfter(playing, { type: "blink-failed" }).state;
        expect(broken.blinking).toBe(false);
        expect(broken.broken).toBe(true);
        const much = broken.nextBlinkAt + 10 * IdleGaps.calm.maxMs;
        expect(time(time(broken, much - 100, 4.4).state, much, 0.1).blink).toBe(false);
    });
});
