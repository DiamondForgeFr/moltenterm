// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How the app asks Brokk for a gesture (FR-BOSS-007, AC3): the small part that is always loaded with the bubble, so that
// the first call gesture can be asked before anything of his animated portrait has loaded. Everything that draws him,
// his clips, the gestures' poses and the rules of the other gestures (brokk-state-model.ts, brokk-moments.ts, brokk-live.tsx) loads
// on the first opening of the screen or the first call, never with the bubble: keep this file free of them (no manifest,
// no package, no model of an agent or a review), since every byte of it is JavaScript every tab view loads up front.
// Pure, so the rules are tested without a window or a clock.

// The gestures the app asks of him; the manifest holds the length of each one.
export type BrokkExpression = "smile" | "doubtful" | "frown" | "nod" | "call";

export type BrokkSituation = {
    // Agents working, in every workspace.
    working: number;
    // Rows To handle: what waits for the developer (the badge's count).
    waiting: number;
    cardOpen: boolean;
    // The developer is away from this computer: no input on it for a long while (developer-away.ts).
    away?: boolean;
};

export type BrokkPose = "rest" | "thinking" | "listening" | "speaking";

// His pose before any gesture or speech (FR-BOSS-007, AC2). Here and not with his portrait, because the comm screen's
// caption, drawn with the bubble, says what this pose shows (AC9). Nothing going on is his awake idle, the listening
// loop with its blinks: rest, the eyes closed, is sleep, and he sleeps only while the developer is away and nothing
// works or waits (#1958). Whatever arrives, or the developer coming back, wakes him.
export function restingPose(situation: BrokkSituation): BrokkPose {
    if (situation.waiting > 0) {
        return "listening";
    }
    if (situation.working > 0) {
        return "thinking";
    }
    return situation.away === true ? "rest" : "listening";
}

// A gesture asked: a new cue plays the same gesture again. `at` is when it was asked.
export type AskedExpression = { expression: BrokkExpression; cue: number; at?: number };

// A failure raises the count of the badge too, so the call and the frown are asked in the same moment. The call only
// gets the developer's eye; the gesture that tells why must not be lost behind it, whichever is asked first.
export const CallYieldMs = 500;

export function askedAfter(current: AskedExpression, expression: BrokkExpression, now: number): AskedExpression {
    const cue = (current?.cue ?? 0) + 1;
    if (
        expression === "call" &&
        current != null &&
        current.expression !== "call" &&
        now - (current.at ?? 0) < CallYieldMs
    ) {
        return current;
    }
    return { expression, cue, at: now };
}

// The count rose since the last reading; the first reading is no rise.
export function rose(before: number, now: number): boolean {
    return before != null && now > before;
}

// The card opened: he speaks only when it opens on something to handle.
export function speaksOnOpen(situation: BrokkSituation): boolean {
    return situation.waiting > 0;
}

// The round at rest plays one gesture, the call, and only when it is asked while the round can show it. `handled` is the
// newest cue the round has played or has no use for; `consumed` says the round cannot play it now: the bubble is
// folded, the window is hidden, motion is reduced, or the open screen plays it itself. A call asked then is not played
// later, when the round could.
export function callPending(asked: AskedExpression, handled: number, consumed: boolean): boolean {
    return !consumed && asked?.expression === "call" && asked.cue > handled;
}

export function handledAfter(handled: number, asked: AskedExpression, consumed: boolean): number {
    return consumed && asked != null && asked.cue > handled ? asked.cue : handled;
}

// What the developer's answer on a To handle row tells him: an approved hand-off is good news, an answer given to an
// agent is an approval he nods at. A refusal or a dismissal says nothing.
export function expressionAfterAnswer(run: { kind: string; decision?: string }): BrokkExpression {
    if (run.kind === "handoff") {
        return run.decision === "once" || run.decision === "always" ? "smile" : null;
    }
    return run.kind === "answer" ? "nod" : null;
}
