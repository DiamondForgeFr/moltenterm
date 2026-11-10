// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What Brokk shows, decided once (FR-BOSS-007, AC10, #1959): his face, the gesture in play, the loader, the round and the
// card's header, all read from the same inputs by `brokkScene`. No surface decides any of them on its own, so the
// screen, the card and the round never tell different stories. Pure and driven by the clock it is handed, so the rules
// are tested row by row without a wait.
//
// The scene has no caption (#2203): the line under his square used to repeat the Notifications panel and the rail's
// badges, and what he says now is his own answer or a moment of a kind colleague (brokk-colleague.ts).
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait (no manifest, no package).
//
// Surface-agnostic on purpose (#1995 moved Brokk from the bubble to the workspace sidebar): it knows nothing of where
// a surface sits or how large it is, only what the surfaces show. The avatar, the card or a test read the same scene;
// where and how big is each surface's own business (brokk-avatar-model.ts).

import type { Badge } from "./boss-overview";
import type { AskedExpression, BrokkExpression, BrokkPose, BrokkSituation } from "./brokk-ask-model";
import { restingPose } from "./brokk-ask-model";
import {
    ImpatientAfterMs,
    MoodFacts,
    MoodMemory,
    moodOf,
    MoodView,
    nextNightChange,
    ReliefMs,
    SatisfiedMs,
} from "./brokk-mood";
import { ExpressionMs } from "./brokk-queue";

// After this long at work he thinks quietly.
export const LongThoughtMs = 5 * 60 * 1000;
// His blinks stay calm this long after the last keystroke. Longer than KeyQuietMs, so the rhythm does not flip at
// every pause in a sentence, short enough that he is lively again once the developer reads or waits.
export const TypingCalmMs = 20_000;

// A line of a visit: a key with its variables (translated where it is shown, so that the language follows the app), or
// text the source wrote itself.
export type CaptionLine = { key?: string; count?: number; vars?: Record<string, string | number>; text?: string };

// How the package spaces his blinks.
export type BlinkRhythm = "normal" | "calm";

export type SceneInput = {
    situation: BrokkSituation;
    now: number;
    memory: MoodMemory;
    facts: MoodFacts;
    badge: Pick<Badge, "count" | "tone" | "text">;
    // The newest expression the queue started: it is the gesture in play while its clip lasts.
    asked: AskedExpression;
    // The few seconds after the card opened on rows to handle: he says them.
    speaking: boolean;
    // The clips may play: motion is not reduced and the window shows.
    motion: boolean;
    // A moving portrait of his already stands next to the open card (the comm screen, today), so the card's header does
    // not need one of its own: the surface says so, the scene does not look for it.
    pinned: boolean;
    lastKeyAt: number;
    // Since when the oldest agent at work works, 0 when none does: after a long thought he blinks less.
    workingSince: number;
};

export type BrokkScene = {
    // His pose before any gesture; "speaking" while he says the rows to handle.
    face: BrokkPose;
    gesture: BrokkExpression;
    // The domino: agents work.
    loader: boolean;
    // The round at rest: always the still, with the badge and the call.
    round: { count: number; tone: Badge["tone"]; text: string; calling: boolean };
    // The card's header shows the still.
    headerStill: boolean;
    mood: MoodView;
    rhythm: BlinkRhythm;
    // When the scene changes by itself, because a wait crosses a limit or the night begins or ends.
    until: number;
};

// The moments the scene changes at with nothing else happening.
function changesAt(input: SceneInput): number {
    const { memory, now } = input;
    const at: number[] = [nextNightChange(now)];
    const add = (since: number, ms: number) => {
        if (since != null && since + ms > now) {
            at.push(since + ms);
        }
    };
    add(memory.reliefAt, ReliefMs);
    add(memory.satisfiedAt, SatisfiedMs);
    add(input.lastKeyAt, TypingCalmMs);
    if (input.asked != null) {
        add(input.asked.at, ExpressionMs[input.asked.expression]);
    }
    if (input.workingSince > 0) {
        add(input.workingSince, LongThoughtMs);
    }
    const since = input.facts.oldest?.since;
    if (since > 0 && input.situation.waiting > 0) {
        ImpatientAfterMs.forEach((limit) => add(since, limit));
    }
    return Math.min(...at);
}

// The expression the queue started, while its clip lasts.
function gestureOf(asked: AskedExpression, now: number): BrokkExpression {
    return asked != null && now - asked.at >= 0 && now - asked.at < ExpressionMs[asked.expression]
        ? asked.expression
        : null;
}

export function brokkScene(input: SceneInput): BrokkScene {
    const { situation, now } = input;
    const view = moodOf(input.memory, input.facts, now);
    const rest = restingPose(situation);
    const speaking = input.speaking && situation.waiting > 0 && rest === "listening";
    const gesture = input.motion ? gestureOf(input.asked, now) : null;
    const typing = input.lastKeyAt != null && now - input.lastKeyAt < TypingCalmMs;
    const longThought = input.workingSince > 0 && situation.working > 0 && now - input.workingSince >= LongThoughtMs;
    return {
        face: speaking ? "speaking" : rest,
        gesture,
        loader: situation.working > 0,
        round: {
            count: input.badge.count,
            tone: input.badge.tone,
            text: input.badge.text,
            calling: gesture === "call",
        },
        headerStill: input.pinned,
        mood: view,
        rhythm: view.tired || typing || longThought ? "calm" : "normal",
        until: changesAt(input),
    };
}
