// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Severity } from "./brokk-queue";
import {
    DrawnCapMs,
    exampleSceneActions,
    LaterLabelKeys,
    laterOptions,
    MotionTimings,
    SceneClipNames,
    sceneClipOf,
    SceneClock,
    sceneEscapes,
    sceneGestureOf,
    sceneLabel,
    ScenePose,
    SceneQuietMs,
    sceneRecurDelayMs,
    SceneRecurGap,
    sceneTimings,
    sceneWaitGestureOf,
    SceneWaitGestures,
    SeverityLabelKeys,
    startSceneGestures,
    unmountAfterMs,
} from "./brokk-visit-scene-model";
import Manifest from "./portrait/brokk/brokk-manifest.json";

// The length of a clip from its WebM header (the Segment's Duration, in TimecodeScale units of 1 ms by default).
function clipMs(name: string): number {
    const data = readFileSync(join(__dirname, "portrait", "brokk", `${name}.webm`));
    for (let i = 0; i + 3 < data.length; i++) {
        if (data[i] !== 0x44 || data[i + 1] !== 0x89) {
            continue;
        }
        if (data[i + 2] === 0x88) {
            return data.readDoubleBE(i + 3);
        }
        if (data[i + 2] === 0x84) {
            return data.readFloatBE(i + 3);
        }
    }
    throw new Error(`${name}.webm has no duration`);
}

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

describe("he waits naturally: his face says why once, then the waiting idles, and a grave visit sighs (#2025, #2262)", () => {
    const CapMs = 10_000;
    const capMs = () => CapMs;
    const FrownMs = 2_625;
    const SighMs = 2_938;
    const Grave = { arrival: "frown", wait: "sigh" } as const;

    function scene(severity: Severity, randoms: number[] = [0.5]) {
        const fake = fakeClock(randoms);
        const played: { expression: string; cue: number; at: number }[] = [];
        const gestures = startSceneGestures(
            fake.clock,
            { arrival: sceneGestureOf(severity), wait: sceneWaitGestureOf(severity) },
            capMs,
            (cue) => played.push({ ...cue, at: fake.now() })
        );
        return { ...fake, played, gestures, names: () => played.map((p) => p.expression) };
    }

    it("plays the face of the severity once as he arrives, then waits in the listening pose with the package's idles", () => {
        for (const severity of ["important", "neutre", "bonne"] as Severity[]) {
            const s = scene(severity);
            expect(s.names(), severity).toEqual([sceneGestureOf(severity)]);
            expect(ScenePose).toBe("listening");
            s.advance(4_625);
            s.gestures.heard(sceneGestureOf(severity), "end");
            s.gestures.heard("scratch", "start");
            s.gestures.heard("scratch", "end");
            s.advance(10 * SceneRecurGap.maxMs);
            // The face of the severity never comes back: the waiting idles took its place.
            expect(s.names(), severity).toEqual([sceneGestureOf(severity)]);
            expect(s.pending(), severity).toBe(0);
            s.gestures.stop();
        }
    });

    it("has a waiting gesture for a grave visit only, his sigh, after the frown of his arrival", () => {
        expect(SceneWaitGestures).toEqual({ grave: "sigh" });
        expect(sceneWaitGestureOf("grave")).toBe("sigh");
        for (const severity of ["important", "neutre", "bonne"] as Severity[]) {
            expect(sceneWaitGestureOf(severity), severity).toBeNull();
        }
        expect({ arrival: sceneGestureOf("grave"), wait: sceneWaitGestureOf("grave") }).toEqual(Grave);
    });

    it("sighs inside 20 to 40 s after the last gesture asked of him ended, never twice in a row", () => {
        const s = scene("grave", [0, 1, 0.37, 0.82, 0.5]);
        expect(s.names()).toEqual(["frown"]);
        const waits: number[] = [];
        let endedAt = 0;
        s.advance(FrownMs);
        endedAt = s.now();
        s.gestures.heard("frown", "end");
        for (let i = 0; i < 6; i++) {
            const count = s.played.length;
            for (let step = 0; s.played.length === count && step < 100; step++) {
                s.advance(1_000);
            }
            expect(s.played.length, `round ${i}`).toBe(count + 1);
            waits.push(s.played[s.played.length - 1].at - endedAt);
            s.advance(SighMs);
            endedAt = s.now();
            s.gestures.heard("sigh", "end");
        }
        expect(s.names().slice(1)).toEqual(Array(6).fill("sigh"));
        for (const wait of waits) {
            expect(wait).toBeGreaterThanOrEqual(SceneRecurGap.minMs);
            expect(wait).toBeLessThanOrEqual(SceneRecurGap.maxMs + 1_000);
        }
        // Jitter: the waits are not all the same.
        expect(new Set(waits).size).toBeGreaterThan(1);
        // A new cue each time: the package plays the same gesture again.
        expect(new Set(s.played.map((p) => p.cue)).size).toBe(s.played.length);
        s.gestures.stop();
    });

    it("never sighs over an idle the package drew by chance: it waits for its end and a round of his loop", () => {
        const s = scene("grave", [0]);
        s.advance(FrownMs);
        s.gestures.heard("frown", "end");
        s.advance(SceneRecurGap.minMs - 1_000);
        s.gestures.heard("beard", "start");
        s.advance(5_000);
        expect(s.names()).toEqual(["frown"]);
        s.gestures.heard("beard", "end");
        s.advance(SceneQuietMs - 1);
        expect(s.names()).toEqual(["frown"]);
        s.advance(1);
        expect(s.names()).toEqual(["frown", "sigh"]);
        s.gestures.stop();
    });

    it("waits again when the package draws another idle before the round is over", () => {
        const s = scene("grave", [0]);
        s.advance(FrownMs);
        s.gestures.heard("frown", "end");
        s.gestures.heard("glance", "start");
        s.advance(SceneRecurGap.minMs);
        s.gestures.heard("glance", "end");
        s.advance(SceneQuietMs - 500);
        s.gestures.heard("lookaround", "start");
        s.advance(3_000);
        expect(s.names()).toEqual(["frown"]);
        s.gestures.heard("lookaround", "end");
        s.advance(SceneQuietMs);
        expect(s.names()).toEqual(["frown", "sigh"]);
        s.gestures.stop();
    });

    it("lets go of an idle whose end never comes, after longer than any he ships", () => {
        const s = scene("grave", [0]);
        s.advance(FrownMs);
        s.gestures.heard("frown", "end");
        s.gestures.heard("scratch", "start");
        s.advance(SceneRecurGap.minMs + DrawnCapMs - 1);
        expect(s.names()).toEqual(["frown"]);
        s.advance(1);
        expect(s.names()).toEqual(["frown", "sigh"]);
        s.gestures.stop();
    });

    it("keeps a round of his loop and a cap longer than every idle the manifest draws by chance", () => {
        const drawn = Manifest.idles.listening.filter((idle) => !("onDemand" in idle && idle.onDemand));
        expect(drawn.map((idle) => idle.name)).toEqual(["blink", "glance", "breath", "lookaround", "beard", "scratch"]);
        for (const idle of drawn) {
            expect(clipMs(`listening.${idle.name}`), idle.name).toBeLessThan(DrawnCapMs);
        }
        expect(SceneQuietMs).toBe(Math.round(clipMs("listening") / 100) * 100);
    });

    it("draws each wait between the bounds, whatever chance says", () => {
        expect(SceneRecurGap).toEqual({ minMs: 20_000, maxMs: 40_000 });
        expect(sceneRecurDelayMs(0)).toBe(20_000);
        expect(sceneRecurDelayMs(1)).toBe(40_000);
        expect(sceneRecurDelayMs(0.5)).toBe(30_000);
        expect(sceneRecurDelayMs(-1)).toBe(20_000);
        expect(sceneRecurDelayMs(2)).toBe(40_000);
    });

    it("still sighs when the package never says a gesture of his ended, after its longest length and a wait", () => {
        const s = scene("grave", [0]);
        s.advance(CapMs + SceneRecurGap.minMs - 1);
        expect(s.names()).toEqual(["frown"]);
        s.advance(1);
        expect(s.names()).toEqual(["frown", "sigh"]);
        s.gestures.stop();
    });

    it("stops with the visit: nothing plays once it has gone", () => {
        const s = scene("grave");
        s.gestures.stop();
        expect(s.pending()).toBe(0);
        s.gestures.heard("frown", "end");
        s.gestures.heard("glance", "end");
        s.advance(10 * SceneRecurGap.maxMs);
        expect(s.names()).toEqual(["frown"]);
    });
});

describe("the example of Show a visit (FR-BOSS-009, AC31 and AC32, #2079)", () => {
    const say = (key: string, vars: Record<string, any> = {}) => `${key}|${JSON.stringify(vars)}`;

    it("names itself an example, and says so in its accessible name", () => {
        expect(sceneLabel(say, "Brokk", "important", true)).toBe(
            `boss.visit.example|${JSON.stringify({ name: "Brokk", severity: say(SeverityLabelKeys.important) })}`
        );
        expect(sceneLabel(say, "Brokk", "important")).toContain("boss.visit.label");
    });

    it("has every action only close it: no panel, no delay", () => {
        let closed = 0;
        const actions = exampleSceneActions(() => closed++);
        actions.fold();
        actions.choose("15min");
        actions.escape();
        expect(closed).toBe(3);
    });
});
