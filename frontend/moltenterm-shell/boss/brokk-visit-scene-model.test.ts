// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Severity } from "./brokk-queue";
import {
    LaterLabelKeys,
    laterOptions,
    MotionTimings,
    SceneClipNames,
    sceneClipOf,
    sceneEscapes,
    SceneClock,
    sceneLabel,
    ScenePose,
    sceneRecurDelayMs,
    SceneRecurGap,
    SeverityLabelKeys,
    sceneTimings,
    startSceneGestures,
    unmountAfterMs,
} from "./brokk-visit-scene-model";

// A clock that only moves when the test moves it: the timers run in order of their due time.
function fakeClock(randoms: number[] = [0.5]) {
    let now = 0;
    let next = 0;
    let draw = 0;
    const timers = new Map<number, { at: number; run: () => void }>();
    const clock: SceneClock = {
        setTimer: (run, ms) => {
            const id = ++next;
            timers.set(id, { at: now + ms, run });
            return id;
        },
        clearTimer: (id) => {
            timers.delete(id as number);
        },
        random: () => randoms[draw++ % randoms.length],
    };
    const advance = (ms: number) => {
        const end = now + ms;
        for (;;) {
            const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (due == null) {
                break;
            }
            timers.delete(due[0]);
            now = due[1].at;
            due[1].run();
        }
        now = end;
    };
    return { clock, advance, now: () => now, pending: () => timers.size };
}

const Severities: Severity[] = ["grave", "important", "neutre", "bonne"];
// 14:00 on the local clock: this evening (18:00) is 4 h away.
const T = new Date(2026, 10, 6, 14, 0, 0).getTime();

describe("what the scene says (FR-BOSS-009, AC6)", () => {
    // The key and its variables, as the dictionaries render them.
    const say = (key: string, vars: Record<string, any> = {}) => `${key}|${JSON.stringify(vars)}`;

    it("names him and the severity, for every severity, and nothing else", () => {
        for (const severity of Severities) {
            expect(sceneLabel(say, "Brokk", severity)).toBe(
                `boss.visit.label|${JSON.stringify({ name: "Brokk", severity: say(SeverityLabelKeys[severity]) })}`
            );
        }
        expect(new Set(Severities.map((severity) => SeverityLabelKeys[severity])).size).toBe(4);
    });

    it("makes the face of the severity: grave frowns, important looks doubtful, neutre calls, bonne smiles", () => {
        expect(sceneClipOf("grave")).toBe("listening.frown");
        expect(sceneClipOf("important")).toBe("listening.doubtful");
        expect(sceneClipOf("neutre")).toBe("listening.call");
        expect(sceneClipOf("bonne")).toBe("listening.smile");
    });

    it("names clips his package really ships", () => {
        const clips = join(__dirname, "portrait", "brokk");
        for (const name of Object.values(SceneClipNames)) {
            expect(() => readFileSync(join(clips, `${name}.webm`)), name).not.toThrow();
        }
    });
});

describe("the Plus tard menu per severity (AC7)", () => {
    const ids = (severity: Severity, now: number = T) => laterOptions(severity, now).map((option) => option.id);

    it("offers 5 min, 15 min and 1 h for a grave visit", () => {
        expect(ids("grave")).toEqual(["5min", "15min", "1h"]);
    });

    it("offers 15 min, 1 h and this evening for an important one", () => {
        expect(ids("important")).toEqual(["15min", "1h", "tonight"]);
    });

    it("offers 1 h, this evening and tomorrow morning for a neutre one and for good news", () => {
        expect(ids("neutre")).toEqual(["1h", "tonight", "tomorrow"]);
        expect(ids("bonne")).toEqual(["1h", "tonight", "tomorrow"]);
    });

    it("marks the first delay as the one Escape takes", () => {
        for (const severity of Severities) {
            const options = laterOptions(severity, T);
            expect(options.map((option) => option.isDefault)).toEqual(options.map((_, i) => i === 0));
        }
        expect(laterOptions("grave", T)[0].until).toBe(T + 5 * 60_000);
        expect(laterOptions("important", T)[0].until).toBe(T + 15 * 60_000);
        expect(laterOptions("neutre", T)[0].until).toBe(T + 60 * 60_000);
    });

    it("leaves this evening out of the menu once it is an hour away or less", () => {
        const lateAfternoon = new Date(2026, 10, 6, 17, 30, 0).getTime();
        expect(ids("important", lateAfternoon)).toEqual(["15min", "1h"]);
        expect(ids("neutre", lateAfternoon)).toEqual(["1h", "tomorrow"]);
    });

    it("gives each delay its own words", () => {
        const keys = Object.values(LaterLabelKeys);
        expect(new Set(keys).size).toBe(keys.length);
        for (const severity of Severities) {
            for (const option of laterOptions(severity, T)) {
                expect(option.labelKey).toBe(LaterLabelKeys[option.id]);
            }
        }
    });
});

describe("what Escape means on the scene (AC6)", () => {
    it("takes the default delay of the severity", () => {
        expect(sceneEscapes("Escape")).toBe(true);
    });

    it("is no other key, and not the Escape of an input method composing", () => {
        for (const key of ["Enter", " ", "a", "Tab", "Backspace"]) {
            expect(sceneEscapes(key), key).toBe(false);
        }
        expect(sceneEscapes("Escape", true)).toBe(false);
    });
});

describe("how long each movement lasts (AC6)", () => {
    it("grows in 360 ms, slides the content down in 320 ms and folds back in 300 ms", () => {
        expect(sceneTimings(false)).toEqual({ openMs: 360, slideDownMs: 320, closeMs: 300, fadeMs: 150 });
        expect(sceneTimings(false)).toBe(MotionTimings);
    });

    it("cross-fades in 150 ms and moves nothing under reduced motion", () => {
        const reduced = sceneTimings(true);
        expect(reduced.openMs).toBe(150);
        expect(reduced.closeMs).toBe(150);
        expect(reduced.slideDownMs).toBe(0);
    });

    it("unmounts the scene only after it has gone", () => {
        expect(unmountAfterMs(false)).toBeGreaterThan(MotionTimings.closeMs);
        expect(unmountAfterMs(false)).toBeGreaterThan(MotionTimings.slideDownMs);
        expect(unmountAfterMs(true)).toBeGreaterThan(MotionTimings.fadeMs);
    });
});

describe("he waits naturally, and his face says why now and then (#2025)", () => {
    const CapMs = 10_000;
    const GestureMs = 4_625;

    it("plays the face of the severity once as he arrives, then waits in the listening pose", () => {
        const { clock, advance } = fakeClock();
        const cues: number[] = [];
        const gestures = startSceneGestures(clock, CapMs, (n) => cues.push(n));
        expect(cues).toEqual([1]);
        expect(ScenePose).toBe("listening");
        advance(GestureMs);
        gestures.ended();
        advance(SceneRecurGap.minMs - 1);
        expect(cues).toEqual([1]);
        gestures.stop();
    });

    it("comes back inside 20 to 40 s after the last one ended, never twice in a row", () => {
        const randoms = [0, 1, 0.37, 0.82, 0.5];
        const { clock, advance, now } = fakeClock(randoms);
        const at: number[] = [];
        const gestures = startSceneGestures(clock, CapMs, () => at.push(now()));
        const waits: number[] = [];
        for (let i = 0; i < 8; i++) {
            const played = at.length;
            advance(GestureMs);
            const endedAt = now();
            gestures.ended();
            for (let step = 0; at.length === played && step < 100; step++) {
                advance(1_000);
            }
            expect(at.length, `round ${i}`).toBe(played + 1);
            waits.push(at[at.length - 1] - endedAt);
        }
        for (const wait of waits) {
            expect(wait).toBeGreaterThanOrEqual(SceneRecurGap.minMs);
            expect(wait).toBeLessThanOrEqual(SceneRecurGap.maxMs + 1_000);
        }
        // Jitter: the waits are not all the same.
        expect(new Set(waits).size).toBeGreaterThan(1);
        gestures.stop();
    });

    it("draws each wait between the bounds, whatever chance says", () => {
        expect(SceneRecurGap).toEqual({ minMs: 20_000, maxMs: 40_000 });
        expect(sceneRecurDelayMs(0)).toBe(20_000);
        expect(sceneRecurDelayMs(1)).toBe(40_000);
        expect(sceneRecurDelayMs(0.5)).toBe(30_000);
        expect(sceneRecurDelayMs(-1)).toBe(20_000);
        expect(sceneRecurDelayMs(2)).toBe(40_000);
    });

    it("still comes back when the package never says the face ended, after its longest length and a wait", () => {
        const { clock, advance } = fakeClock([0]);
        const cues: number[] = [];
        const gestures = startSceneGestures(clock, CapMs, (n) => cues.push(n));
        advance(CapMs + SceneRecurGap.minMs - 1);
        expect(cues).toEqual([1]);
        advance(1);
        expect(cues).toEqual([1, 2]);
        gestures.stop();
    });

    it("stops with the visit: nothing plays once it has gone", () => {
        const { clock, advance, pending } = fakeClock();
        const cues: number[] = [];
        const gestures = startSceneGestures(clock, CapMs, (n) => cues.push(n));
        gestures.stop();
        expect(pending()).toBe(0);
        gestures.ended();
        advance(10 * SceneRecurGap.maxMs);
        expect(cues).toEqual([1]);
    });
});
