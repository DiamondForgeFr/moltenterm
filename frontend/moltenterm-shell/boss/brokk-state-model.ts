// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What Brokk's face does (FR-BOSS-007, AC2, AC3): the four poses MoltenTerm's own signals put him in, and how an
// expression the app asks of him, or a few words after the card opens, change that pose. Pure, so the rules are tested
// without a window or a clock; the portrait (brokk-live.tsx) only draws the pose this gives. The shared package knows
// none of it: it draws the pose it is handed.
//
// It reads his manifest, so it belongs to the animated portrait, which loads on the first opening of the screen or the
// first call: nothing the bubble loads up front may import it (brokk-ask-model.ts is the part that does).
//
// The pose never comes from what an agent writes. No `[[expression]]` marker is looked for in output, files or code:
// the signals are the count of agents working, the count of rows To handle and whether the card is open.

import type { AskedExpression, BrokkExpression, BrokkPose, BrokkSituation } from "./brokk-ask-model";
import { restingPose, SpeakingMs } from "./brokk-ask-model";
import Manifest from "./portrait/brokk/brokk-manifest.json";

export type { BrokkPose };

export const BrokkExpressions = Object.keys(Manifest.expressionMs) as BrokkExpression[];

export { SpeakingMs };

// What a clip that carries him into the listening pose may add before the gesture starts (the longest is 4 s), and a
// margin.
const TransitionAllowanceMs = 6000;

// The longest a gesture may hold his pose, should its clip never end (a refused autoplay, a window put to sleep). A
// clip that ends hands the pose back sooner (faceAfter, "clip-ended").
export function reactionCapMs(expression: BrokkExpression): number {
    return (Manifest.expressionMs as Record<string, number>)[expression] + TransitionAllowanceMs;
}

export { restingPose };

export type BrokkFace = {
    // The few seconds after the card opened on items to handle.
    speaking: boolean;
    // The gesture being played, if any.
    expression: BrokkExpression;
};

function hasGesture(pose: BrokkPose, expression: BrokkExpression): boolean {
    const idles = (Manifest.idles as Record<string, { name: string }[]>)[pose] ?? [];
    return idles.some((idle) => idle.name === expression);
}

// A gesture is a clip of a pose's loop. While he makes one he is in the pose that has it: the listening one, or the
// speaking one when he speaks and that pose has it too (the nod). Whatever pose he was in comes back when it ends.
export function brokkPose(situation: BrokkSituation, face: BrokkFace): BrokkPose {
    const base = restingPose(situation);
    const wanted = face.speaking && base === "listening" && situation.waiting > 0 ? "speaking" : base;
    if (face.expression == null) {
        return wanted;
    }
    return hasGesture(wanted, face.expression) ? wanted : "listening";
}

export type FaceState = {
    speaking: boolean;
    reaction: AskedExpression;
    // The last cue seen when the face mounted: what was asked before is not asked again.
    seenCue: number;
};

export type FaceEvent =
    | { type: "asked"; asked: AskedExpression }
    | { type: "gesture-ended"; name: string }
    | { type: "reaction-expired"; cue: number }
    | { type: "speech-expired" }
    // The card opened on items to handle while this face already showed (the comm screen opened by the hover).
    | { type: "speak" };

export function startFace(options: { asked?: AskedExpression; play?: AskedExpression; speaks?: boolean }): FaceState {
    return {
        speaking: options.speaks === true,
        reaction: options.play ?? null,
        seenCue: options.asked?.cue ?? options.play?.cue ?? 0,
    };
}

// What the package says of a gesture (its `onGesture`, FR-BOSS-007, AC17): only the end of one hands the pose back, and
// it says it whether the gesture played to its end, was stopped short by a change of pose or could not load.
export function gestureEvent(name: string, phase: "start" | "end"): FaceEvent {
    return phase === "end" ? { type: "gesture-ended", name } : null;
}

// The same state object when nothing changes, so that no one draws again for it.
export function faceAfter(state: FaceState, event: FaceEvent): FaceState {
    switch (event.type) {
        case "asked":
            if (event.asked.cue === state.seenCue) {
                return state;
            }
            return { ...state, reaction: event.asked, seenCue: event.asked.cue };
        case "gesture-ended":
            if (state.reaction == null || event.name !== state.reaction.expression) {
                return state;
            }
            return { ...state, reaction: null };
        case "reaction-expired":
            return state.reaction?.cue === event.cue ? { ...state, reaction: null } : state;
        case "speech-expired":
            return state.speaking ? { ...state, speaking: false } : state;
        case "speak":
            return state.speaking ? state : { ...state, speaking: true };
        default:
            return state;
    }
}
