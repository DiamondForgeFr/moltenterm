// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The line map's motion (FR-MC-023, DS-MC-015), the parts that are logic rather than CSS: when the load sequence
// plays, how each mark's start is staggered along time, and the switches the frame carries. The motion itself is the
// CSS of line-map.tsx: nothing here runs per frame.

import type { CSSProperties } from "react";
import { LineMapGeometry } from "./line-map-geometry";

// Seconds. The lines draw first; what sits on them appears as the drawing passes it.
export const IntroLineDraw = 1.2;
const StationStart = 0.35;
const StationSpan = 1.1;
const BranchStart = 1.0;
const BranchSpan = 1.0;
const OpenStart = 1.9;
const OpenSpan = 0.3;
export const IntroHead = 1.2;
export const IntroRoute = 1.3;
export const IntroTerminus = 1.5;
export const IntroTerminusText = 1.7;
export const IntroPulse = 1.6;
export const IntroGlints = 2.4;
// The sequence's length: the last open branch's tip has appeared by then. The frame's clock element runs this long.
export const IntroLength = 3.4;

export type IntroPhase = "play" | "done";

// run counts the plays: Replay bumps it, which remounts the drawing so every animation starts over.
export type IntroState = { phase: IntroPhase; run: number };

export type IntroEvent = "end" | "replay" | "reduce";

export function initialIntro(reduced: boolean): IntroState {
    return { phase: reduced ? "done" : "play", run: 0 };
}

// The load sequence plays once per show of the map: a data refresh, a window change or a resize sends no event, so
// once it ended the map redraws in its final state. Only Replay plays it again, and never under reduced motion.
export function introStep(state: IntroState, event: IntroEvent, reduced: boolean): IntroState {
    switch (event) {
        case "end":
        case "reduce":
            return state.phase === "done" ? state : { ...state, phase: "done" };
        case "replay":
            if (reduced) {
                return state;
            }
            return { phase: "play", run: state.run + 1 };
    }
}

export type IntroKind = "line" | "station" | "label" | "branch" | "open";

// Where x sits between the left of develop and now, from 0 to 1.
export function timeFraction(geo: LineMapGeometry, x: number): number {
    const x1 = geo.develop.x1;
    const x2 = geo.head.x;
    if (!(x2 > x1)) {
        return 0;
    }
    return Math.min(1, Math.max(0, (x - x1) / (x2 - x1)));
}

// When a mark at x starts, in seconds: left to right, each kind in its own band of the sequence (the lines, then the
// stations, then the branches, the open ones last).
export function introDelay(geo: LineMapGeometry, kind: IntroKind, x: number): number {
    const f = timeFraction(geo, x);
    switch (kind) {
        case "line":
            return 0.1 + IntroLineDraw * f;
        case "station":
            return StationStart + StationSpan * f;
        case "label":
            return StationStart + StationSpan * f + 0.15;
        case "branch":
            return BranchStart + BranchSpan * f;
        case "open":
            return OpenStart + OpenSpan * f;
    }
}

// The CSS variable a mark reads its start from.
export function delayStyle(seconds: number): CSSProperties {
    return { ["--lm-d" as string]: `${seconds.toFixed(2)}s` } as CSSProperties;
}

// The switches the map's frame carries; the CSS keys every animation on them. They sit outside the memoized drawing,
// so flipping one never re-renders the SVG.
export function motionAttrs(opts: { reduced: boolean; paused: boolean; intro: IntroPhase }): Record<string, string> {
    return {
        "data-motion": opts.reduced ? "reduce" : "full",
        "data-intro": opts.reduced ? "done" : opts.intro,
        "data-paused": opts.paused ? "true" : "false",
    };
}
