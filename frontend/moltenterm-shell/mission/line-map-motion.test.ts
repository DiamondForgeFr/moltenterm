// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { layoutLineMap } from "./line-map-geometry";
import { LineMapModel } from "./line-map-model";
import {
    delayStyle,
    initialIntro,
    introDelay,
    IntroEvent,
    IntroLength,
    IntroLineDraw,
    IntroState,
    introStep,
    motionAttrs,
    timeFraction,
} from "./line-map-motion";

const Day = 86_400_000;
const NOW = new Date("2026-10-05T12:00:00Z").getTime();

function model(): LineMapModel {
    return {
        start: NOW - 21 * Day,
        now: NOW,
        days: 21,
        trunk: "develop",
        release: "main",
        head: null,
        commits: [],
        branches: [],
        stations: [],
        earlier: [],
        terminus: { version: "1.0.0", tag: "v1.0.0", how: "decision", reason: "", waiting: 3 },
        github: "",
        historyFrom: null,
    };
}

function run(events: IntroEvent[], reduced = false): IntroState {
    return events.reduce((state, e) => introStep(state, e, reduced), initialIntro(reduced));
}

describe("load sequence, once per show", () => {
    it("plays when the map is shown, and ends once", () => {
        expect(initialIntro(false)).toEqual({ phase: "play", run: 0 });
        expect(run(["end"])).toEqual({ phase: "done", run: 0 });
    });

    it("stays ended: a refresh or a window change sends nothing, a second end changes nothing", () => {
        const done = run(["end"]);
        expect(introStep(done, "end", false)).toBe(done);
    });

    it("plays again on Replay, with a new run so the drawing restarts", () => {
        expect(run(["end", "replay"])).toEqual({ phase: "play", run: 1 });
        expect(run(["end", "replay", "end", "replay"])).toEqual({ phase: "play", run: 2 });
    });

    it("never plays under reduced motion, and Replay does nothing there", () => {
        expect(initialIntro(true).phase).toBe("done");
        expect(run(["replay"], true)).toEqual({ phase: "done", run: 0 });
    });

    it("ends at once when reduced motion is turned on while it plays", () => {
        expect(run(["reduce"])).toEqual({ phase: "done", run: 0 });
    });
});

describe("stagger along time", () => {
    const geo = layoutLineMap(model(), { width: 1400 });
    const x1 = geo.develop.x1;
    const now = geo.head.x;

    it("measures x from develop's left end to now", () => {
        expect(timeFraction(geo, x1)).toBe(0);
        expect(timeFraction(geo, now)).toBe(1);
        expect(timeFraction(geo, (x1 + now) / 2)).toBeCloseTo(0.5);
        expect(timeFraction(geo, -50)).toBe(0);
        expect(timeFraction(geo, now + 300)).toBe(1);
    });

    it("starts marks left to right", () => {
        for (const kind of ["line", "station", "branch", "open"] as const) {
            expect(introDelay(geo, kind, x1 + 100)).toBeLessThan(introDelay(geo, kind, x1 + 400));
        }
    });

    it("follows the drawing of the lines: a mark appears as the line reaches it", () => {
        expect(introDelay(geo, "line", now)).toBeCloseTo(0.1 + IntroLineDraw);
    });

    it("pops the stations before the branches draw, the open branches last, inside the sequence", () => {
        expect(introDelay(geo, "station", x1)).toBeLessThan(introDelay(geo, "branch", x1));
        expect(introDelay(geo, "label", x1)).toBeGreaterThan(introDelay(geo, "station", x1));
        expect(introDelay(geo, "branch", now)).toBeLessThan(introDelay(geo, "open", now) + 0.01);
        // The open branch draws for 0.7 s, then its tip fades in for 0.4 s.
        expect(introDelay(geo, "open", now) + 0.7 + 0.4).toBeLessThanOrEqual(IntroLength);
    });

    it("hands the delay to CSS as a variable", () => {
        expect(delayStyle(0.4)).toEqual({ "--lm-d": "0.40s" });
    });
});

describe("motion switches", () => {
    it("runs everything with motion on", () => {
        expect(motionAttrs({ reduced: false, paused: false, intro: "play" })).toEqual({
            "data-motion": "full",
            "data-intro": "play",
            "data-paused": "false",
        });
    });

    it("turns everything off under reduced motion, whatever the sequence", () => {
        expect(motionAttrs({ reduced: true, paused: false, intro: "play" })).toMatchObject({
            "data-motion": "reduce",
            "data-intro": "done",
        });
    });

    it("pauses when hidden", () => {
        expect(motionAttrs({ reduced: false, paused: true, intro: "done" })["data-paused"]).toBe("true");
    });
});
