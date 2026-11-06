// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What Brokk shows, decided once (FR-BOSS-007, AC10 and AC11, #1959): his face, the gesture in play, the comm screen's
// caption, the loader, the round and the hover card's headline, all read from the same inputs by `brokkScene`. No
// surface decides any of them on its own, so the screen, the card and the round never tell different stories. Pure and
// driven by the clock it is handed, so the rules are tested row by row without a wait.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait (no manifest, no package).
//
// Surface-agnostic on purpose (#1995 moved Brokk from the bubble to the workspace sidebar): it knows nothing of where
// a surface sits or how large it is, only what the surfaces show. The avatar's tooltip, the card or a test read the same
// scene; where and how big is each surface's own business (brokk-avatar-model.ts).

import type { Badge } from "./boss-overview";
import type { AskedExpression, BrokkExpression, BrokkPose, BrokkSituation } from "./brokk-ask-model";
import { restingPose } from "./brokk-ask-model";
import {
    BackMs,
    HandledKind,
    HandledMs,
    ImpatientAfterMs,
    MoodFacts,
    MoodMemory,
    MoodNews,
    moodOf,
    MoodView,
    NewsMs,
    nextNightChange,
    ReliefMs,
    SatisfiedMentionMs,
    SatisfiedMs,
} from "./brokk-mood";
import { ExpressionMs, KeyQuietMs } from "./brokk-queue";

// After this long at work he thinks quietly.
export const LongThoughtMs = 5 * 60 * 1000;

// A line of the caption or of the hover card: a key with its variables (translated where it is shown, so that the
// language follows the app), or text the source wrote itself.
export type CaptionLine = { key?: string; count?: number; vars?: Record<string, string | number>; text?: string };
export type ScreenCaption = { status: CaptionLine; detail?: CaptionLine };

// How the package should space his blinks (step B of #1959: the package cannot take it yet, MoltenTerm only says it).
export type BlinkRhythm = "normal" | "calm";

export type SceneInput = {
    situation: BrokkSituation;
    now: number;
    memory: MoodMemory;
    facts: MoodFacts;
    // The sentence of the most urgent row To handle the developer has not acted on, null when none waits.
    top: CaptionLine;
    // The name of the one agent at work, when exactly one works.
    worker: string;
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
    // A plan reading at 80 % or more, as a line; null when there is none.
    usage: CaptionLine;
};

export type BrokkScene = {
    // His pose before any gesture; "speaking" while he says the rows to handle.
    face: BrokkPose;
    gesture: BrokkExpression;
    caption: ScreenCaption;
    // The domino: agents work.
    loader: boolean;
    // The round at rest: always the still, with the badge and the call.
    round: { count: number; tone: Badge["tone"]; text: string; calling: boolean };
    // The hover card's first lines: the screen's status, without what only the open card has (his sentence, "Noted").
    card: ScreenCaption;
    // The card's header shows the still.
    headerStill: boolean;
    mood: MoodView;
    rhythm: BlinkRhythm;
    // When the scene changes by itself, because a mention runs out, a wait crosses a limit or the night begins or
    // ends.
    until: number;
};

function workingLine(working: number, worker: string): CaptionLine {
    if (working === 1 && worker) {
        return { key: "boss.screen.working", vars: { name: worker } };
    }
    return { key: "boss.screen.workingCount", count: working };
}

function toHandleLine(count: number): CaptionLine {
    return { key: "boss.screen.toHandle", count };
}

const HandledKeys: Record<HandledKind, string> = {
    answer: "boss.screen.handled.answer",
    rerun: "boss.screen.handled.rerun",
    handoff: "boss.screen.handled.handoff",
    done: "boss.screen.handled.done",
};

function recent(at: number, now: number, ms: number): boolean {
    return at != null && now - at >= 0 && now - at < ms;
}

function newsCaption(news: MoodNews, working: number, worker: string): ScreenCaption {
    const atWork = working > 0 ? workingLine(working, worker) : undefined;
    if (news.kind === "merged") {
        return { status: { key: "boss.screen.merged", vars: { number: news.number } }, detail: atWork };
    }
    if (news.kind === "cleared") {
        return { status: { key: "boss.screen.cleared" }, detail: { key: "boss.screen.thanks" } };
    }
    if (news.all) {
        return { status: { key: "boss.screen.finishedAll" }, detail: atWork ?? { key: "boss.screen.nothingForYou" } };
    }
    return { status: { key: "boss.screen.finished", vars: { name: news.name } }, detail: atWork };
}

function backCaption(back: MoodMemory["back"]): ScreenCaption {
    const { finished, arrived } = back.summary;
    const status = { key: "boss.screen.welcomeBack" };
    if (finished.length > 0) {
        return {
            status,
            detail: { key: "boss.screen.backFinished", count: finished.length, vars: { names: finished.join(", ") } },
        };
    }
    if (arrived > 0) {
        return { status, detail: { key: "boss.screen.backArrived", count: arrived } };
    }
    return { status, detail: { key: "boss.screen.backNothing" } };
}

// `open`: what only the open card has, his sentence and the "Noted" that follows an answer.
// The status line and its detail, by order of what matters: what he says now, what the developer just did, the
// developer's return, sleep, a failure, its relief, a long wait, what waits, the news of a moment ago, the good work,
// what works, and nothing going on. The detail of a quiet state carries the one mention that is worth a line.
function captionOf(input: SceneInput, view: MoodView, open: boolean): ScreenCaption {
    const { situation, memory, facts, top, now } = input;
    const { working, waiting } = situation;
    if (open && input.speaking && waiting > 0 && top != null) {
        return { status: { key: "boss.screen.speech", count: waiting, vars: { line: top.text ?? "" } } };
    }
    if (open && recent(memory.handled?.at, now, HandledMs)) {
        return { status: { key: HandledKeys[memory.handled.kind] } };
    }
    if (memory.back != null && recent(memory.back.at, now, BackMs)) {
        return backCaption(memory.back);
    }
    if (restingPose(situation) === "rest") {
        return { status: { key: "boss.screen.asleep" } };
    }
    const atWork = working > 0 ? workingLine(working, input.worker) : undefined;
    const others = waiting > 1 ? toHandleLine(waiting) : atWork;
    if (waiting > 0 && view.mood === "concerned" && top != null) {
        return { status: top, detail: others };
    }
    if (waiting === 0 && view.relieved) {
        return { status: { key: "boss.screen.relieved" }, detail: atWork };
    }
    if (waiting > 0 && view.mood === "impatient" && facts.oldest != null) {
        const minutes = view.waitedMin;
        const status = facts.oldest.agent
            ? { key: "boss.screen.waitedFor", vars: { name: facts.oldest.name, minutes } }
            : { key: "boss.screen.waitedLine", vars: { line: facts.oldest.name, minutes } };
        return { status, detail: others };
    }
    if (waiting > 0) {
        return { status: waiting === 1 && top != null ? top : toHandleLine(waiting), detail: atWork };
    }
    if (memory.news != null && recent(memory.news.at, now, NewsMs)) {
        return newsCaption(memory.news, working, input.worker);
    }
    const tired = view.tired ? { key: "boss.screen.lateNight" } : undefined;
    if (working > 0) {
        return { status: atWork, detail: tired ?? { key: "boss.screen.nothingForYou" } };
    }
    if (view.satisfiedMention) {
        return { status: { key: "boss.screen.quiet" }, detail: { key: "boss.screen.niceWork" } };
    }
    return { status: { key: "boss.screen.quiet" }, detail: tired ?? input.usage ?? undefined };
}

// The hover card says what the screen's status line says; a return is worth its second line too.
function cardOf(input: SceneInput, view: MoodView): ScreenCaption {
    const caption = captionOf(input, view, false);
    const back = input.memory.back != null && recent(input.memory.back.at, input.now, BackMs);
    return back ? caption : { status: caption.status };
}

// The moments the scene changes at with nothing else happening.
function changesAt(input: SceneInput, view: MoodView): number {
    const { memory, now } = input;
    const at: number[] = [nextNightChange(now)];
    const add = (since: number, ms: number) => {
        if (since != null && since + ms > now) {
            at.push(since + ms);
        }
    };
    add(memory.handled?.at, HandledMs);
    add(memory.back?.at, BackMs);
    add(memory.news?.at, NewsMs);
    add(memory.reliefAt, ReliefMs);
    add(memory.satisfiedAt, SatisfiedMentionMs);
    add(memory.satisfiedAt, SatisfiedMs);
    if (input.asked != null) {
        add(input.asked.at, ExpressionMs[input.asked.expression]);
    }
    if (input.workingSince > 0) {
        add(input.workingSince, LongThoughtMs);
    }
    const since = input.facts.oldest?.since;
    if (since > 0 && input.situation.waiting > 0) {
        ImpatientAfterMs.forEach((limit) => add(since, limit));
        if (view.mood === "impatient") {
            add(since, (Math.floor((now - since) / 60000) + 1) * 60000);
        }
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
    const typing = input.lastKeyAt != null && now - input.lastKeyAt < KeyQuietMs;
    const longThought = input.workingSince > 0 && situation.working > 0 && now - input.workingSince >= LongThoughtMs;
    return {
        face: speaking ? "speaking" : rest,
        gesture,
        caption: captionOf(input, view, true),
        loader: situation.working > 0,
        round: {
            count: input.badge.count,
            tone: input.badge.tone,
            text: input.badge.text,
            calling: gesture === "call",
        },
        card: cardOf(input, view),
        headerStill: input.pinned,
        mood: view,
        rhythm: view.tired || typing || longThought ? "calm" : "normal",
        until: changesAt(input, view),
    };
}
