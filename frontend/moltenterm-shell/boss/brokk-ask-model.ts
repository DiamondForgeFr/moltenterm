// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How the app asks Brokk for a gesture (FR-BOSS-007, AC3): the small part that is always loaded with the bubble, so that
// the first call gesture can be asked before anything of his animated portrait has loaded. Everything that draws him,
// his clips, the gestures' poses and the merges' listening (brokk-state-model.ts, brokk-moments.ts, brokk-live.tsx)
// loads on the first opening of the screen or the first call, never with the bubble: keep this file free of them (no
// manifest, no package, no model of an agent or a review), since every byte of it is JavaScript every tab view loads up
// front. Pure, so the rules are tested without a window or a clock.

import type { HandledKind } from "./brokk-mood";

// The gestures the app asks of him; the manifest holds the length of each one. The tone of his answer asks proud, chuckle
// and surprised, and only a grave visit asks the sigh (#2262).
export type BrokkExpression =
    | "smile"
    | "doubtful"
    | "frown"
    | "nod"
    | "call"
    | "sigh"
    | "proud"
    | "chuckle"
    | "surprised";

export type BrokkSituation = {
    // Agents working, in every workspace.
    working: number;
    // Rows To handle: what waits for the developer (the badge's count).
    waiting: number;
    cardOpen: boolean;
    // The developer is away from this computer: no input on it for a long while (developer-away.ts).
    away?: boolean;
    // The conversation (FR-BOSS-009, AC9, AC86 and AC87): he listens while the developer writes to him and while his
    // answer is on its way, thinks once it is slow to come, and speaks while it is said (brokk-speech-model.ts).
    talk?: "typing" | "thinking" | "answering";
};

export type BrokkPose = "rest" | "thinking" | "listening" | "speaking";

// His pose before any gesture or speech (FR-BOSS-007, AC2). Here and not with his portrait, because the comm screen's
// caption, drawn with the bubble, says what this pose shows (AC9). Nothing going on is his awake idle, the listening
// loop with its blinks: rest, the eyes closed, is sleep, and he sleeps only while the developer is away and nothing
// works or waits (#1958). Whatever arrives, or the developer coming back, wakes him. With the card open he looks up,
// even while agents work: the developer came to talk to him (#1959).
export function restingPose(situation: BrokkSituation): BrokkPose {
    if (situation.waiting > 0 || situation.cardOpen || situation.talk != null) {
        return "listening";
    }
    if (situation.working > 0) {
        return "thinking";
    }
    return situation.away === true ? "rest" : "listening";
}

// A gesture the queue started (brokk-queue.ts): a new cue plays the same gesture again. `at` is when it started.
export type AskedExpression = { expression: BrokkExpression; cue: number; at?: number };

// The count rose since the last reading; the first reading is no rise.
export function rose(before: number, now: number): boolean {
    return before != null && now > before;
}

// How long he speaks after the card opens on items to handle, then he listens; the caption says his sentence meanwhile.
export const SpeakingMs = 4000;

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

export type AnswerRun = { kind: string; decision?: string };

// What the developer's action on a To handle row is, for the caption that says "Noted" and the nod that answers it (an
// approval is a nod; the smile is kept for success, #1959): an answer given to an agent, a hand-off allowed (once or
// always), a CI rerun, a "go there and do it" marked done. A refusal, a dismissal, Later and the doors that only go
// somewhere say nothing.
export function handledKindOf(run: AnswerRun): HandledKind {
    switch (run.kind) {
        case "answer":
        case "rerun":
        case "done":
            return run.kind as HandledKind;
        case "handoff":
            return run.decision === "once" || run.decision === "always" ? "handoff" : null;
        default:
            return null;
    }
}
