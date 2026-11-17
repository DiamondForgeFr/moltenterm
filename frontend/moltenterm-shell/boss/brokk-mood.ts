// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's moods (FR-BOSS-007, AC12, #1959): what he feels about the state of the forge, and for how long. A mood is
// mostly read from the state (something fails, something has waited long, something is waiting); only what has to fade
// or to be remembered is kept, in a small memory that `moodAfter` updates one event at a time. Pure and driven by the
// clock it is handed, so the rules are tested without a wait.
//
// It lives with the bubble, not with his portrait: it keeps running while the screen is closed or the window hidden,
// so that the mood is there when the developer looks. It is part of the bubble's up-front JavaScript: it imports
// nothing of the portrait.

import type { BrokkExpression } from "./brokk-ask-model";

export const SatisfiedMs = 10 * 60 * 1000;
// The caption mentions the good work, and the mood replays its smile, for this long only.
export const SatisfiedMentionMs = 5 * 60 * 1000;
export const ReliefMs = 60 * 1000;
// How long the caption tells that an agent finished, a pull request merged or the list was cleared.
export const NewsMs = 2 * 60 * 1000;
export const HandledMs = 3000;
export const BackMs = 60 * 1000;
// Away from the page for this long: coming back is a return, with its summary. The greeting itself is the kind
// colleague's hello, which owns the nod (FR-BOSS-009, AC74, #2217).
export const ReturnAfterMs = 30 * 60 * 1000;
// A mood plays its expression on opening at most this often.
export const ReplayEveryMs = 5 * 60 * 1000;
// A row that waits this long, then this long, earns a doubtful look; never more for the same row.
export const ImpatientAfterMs = [10 * 60 * 1000, 30 * 60 * 1000];
// Tired from this hour to that one, local time.
export const NightFromHour = 23;
export const NightToHour = 6;
// The returns' log keeps this many entries.
const LogLimit = 50;

export type HandledKind = "answer" | "rerun" | "handoff" | "done";

export type MoodNews =
    // `all`: the last agent of the wave finished.
    | { kind: "finished"; at: number; name: string; all: boolean }
    | { kind: "merged"; at: number; number: number }
    | { kind: "cleared"; at: number };

export type BackSummary = { finished: string[]; arrived: number };

export type MoodMemory = {
    // When the last failure was settled; null when none was, or a new one began since.
    reliefAt: number;
    // When the forge last went well: the list cleared, a pull request merged, a wave of work ended without an error.
    satisfiedAt: number;
    news: MoodNews;
    handled: { at: number; kind: HandledKind };
    // The developer came back after a long absence.
    back: { at: number; summary: BackSummary };
    // The longest wait already told with a doubtful look, by row.
    told: Record<string, number>;
    // When a mood last played its expression on opening.
    replayedAt: number;
    // What happened, for the summary of a return.
    log: { at: number; kind: "finished" | "arrived"; name?: string }[];
};

export const EmptyMood: MoodMemory = {
    reliefAt: null,
    satisfiedAt: null,
    news: null,
    handled: null,
    back: null,
    told: {},
    replayedAt: null,
    log: [],
};

export type MoodEvent =
    // A failure that was not there before: the good mood ends.
    | { type: "failed" }
    // The last failure is settled.
    | { type: "settled" }
    | { type: "finished"; name: string; all: boolean }
    // The list To handle is empty after it was not.
    | { type: "cleared" }
    | { type: "merged"; number: number }
    // A row arrived (for the summary of a return).
    | { type: "arrived" }
    | { type: "handled"; kind: HandledKind }
    // The developer is back; `since` is when they last were there.
    | { type: "returned"; since: number }
    | { type: "told"; key: string; afterMs: number }
    // The rows still waiting: the others are forgotten, so that a row that waits again is told again.
    | { type: "still"; keys: string[] }
    | { type: "replayed" };

function within(at: number, now: number, ms: number): boolean {
    return at != null && now - at >= 0 && now - at < ms;
}

function logged(memory: MoodMemory, now: number, entry: { kind: "finished" | "arrived"; name?: string }) {
    return [...memory.log, { at: now, ...entry }].slice(-LogLimit);
}

function summaryOf(memory: MoodMemory, since: number): BackSummary {
    const during = memory.log.filter((entry) => entry.at > since);
    const finished = [...new Set(during.filter((entry) => entry.kind === "finished").map((entry) => entry.name))];
    return { finished, arrived: during.filter((entry) => entry.kind === "arrived").length };
}

// The memory after an event: the very same object when nothing changes, so that no one draws again for it.
export function moodAfter(memory: MoodMemory, event: MoodEvent, now: number): MoodMemory {
    switch (event.type) {
        case "failed":
            if (memory.satisfiedAt == null && memory.reliefAt == null) {
                return memory;
            }
            return { ...memory, satisfiedAt: null, reliefAt: null };
        case "settled":
            return { ...memory, reliefAt: now };
        case "finished":
            return {
                ...memory,
                news: { kind: "finished", at: now, name: event.name, all: event.all },
                satisfiedAt: event.all ? now : memory.satisfiedAt,
                log: logged(memory, now, { kind: "finished", name: event.name }),
            };
        case "cleared":
            return { ...memory, news: { kind: "cleared", at: now }, satisfiedAt: now };
        case "merged":
            return { ...memory, news: { kind: "merged", at: now, number: event.number }, satisfiedAt: now };
        case "arrived":
            return { ...memory, log: logged(memory, now, { kind: "arrived" }) };
        case "handled":
            return { ...memory, handled: { at: now, kind: event.kind } };
        case "returned":
            return {
                ...memory,
                back: { at: now, summary: summaryOf(memory, event.since) },
                log: [],
            };
        case "told":
            if ((memory.told[event.key] ?? 0) >= event.afterMs) {
                return memory;
            }
            return { ...memory, told: { ...memory.told, [event.key]: event.afterMs } };
        case "still": {
            const keep = new Set(event.keys);
            const keys = Object.keys(memory.told);
            if (keys.every((key) => keep.has(key))) {
                return memory;
            }
            return {
                ...memory,
                told: Object.fromEntries(keys.filter((key) => keep.has(key)).map((key) => [key, memory.told[key]])),
            };
        }
        case "replayed":
            return { ...memory, replayedAt: now };
        default:
            return memory;
    }
}

export function isNight(now: number): boolean {
    const hour = new Date(now).getHours();
    return hour >= NightFromHour || hour < NightToHour;
}

// The next moment the local clock reads this minute of the day (0 to 1439), strictly after `now`.
export function nextClockTime(now: number, minuteOfDay: number): number {
    const date = new Date(now);
    const next = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        Math.floor(minuteOfDay / 60),
        minuteOfDay % 60,
        0,
        0
    );
    if (next.getTime() <= now) {
        next.setDate(next.getDate() + 1);
    }
    return next.getTime();
}

// The next moment the night begins or ends, local time: the caption's mention follows it.
export function nextNightChange(now: number): number {
    return nextClockTime(now, (isNight(now) ? NightToHour : NightFromHour) * 60);
}

// Quiet hours (FR-BOSS-009, AC4): a window of the local day, in minutes since midnight, during which only the badge
// changes. A window that crosses midnight (22:00 to 08:00) is on at both of its ends.
export type QuietHours = { on: boolean; from: number; to: number };

export const DefaultQuietHours: QuietHours = { on: true, from: 22 * 60, to: 8 * 60 };

export function minutesOfDay(now: number): number {
    const date = new Date(now);
    return date.getHours() * 60 + date.getMinutes();
}

// "HH:MM" as minutes since midnight; null for anything else, so that an invalid setting reads as its default.
export function parseClock(value: unknown): number {
    const match = typeof value === "string" ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim()) : null;
    return match == null ? null : Number(match[1]) * 60 + Number(match[2]);
}

export function inQuietHours(quiet: QuietHours, now: number): boolean {
    if (!quiet.on || quiet.from === quiet.to) {
        return false;
    }
    const minute = minutesOfDay(now);
    return quiet.from < quiet.to
        ? minute >= quiet.from && minute < quiet.to
        : minute >= quiet.from || minute < quiet.to;
}

// The next moment the quiet hours begin or end, or null when they are off.
export function nextQuietChange(quiet: QuietHours, now: number): number {
    if (!quiet.on || quiet.from === quiet.to) {
        return null;
    }
    return nextClockTime(now, inQuietHours(quiet, now) ? quiet.to : quiet.from);
}

export type Mood = "concerned" | "impatient" | "attentive" | "satisfied" | "neutral";

// What the state says, from the rows To handle that the developer has not acted on.
export type MoodFacts = {
    // Something fails: an agent in error, a failing CI.
    failing: boolean;
    waiting: number;
    // The longest wait among the rows that wait for an answer: its key, its name, since when, and whether an agent waits.
    oldest: { key: string; name: string; since: number; agent: boolean };
};

export type MoodView = {
    mood: Mood;
    // Added to the mood, never in its place: it is night.
    tired: boolean;
    // A failure was settled a moment ago and nothing fails now.
    relieved: boolean;
    // The caption still mentions the good work.
    satisfiedMention: boolean;
    // Whole minutes the oldest row has waited, when it has waited long enough to be told.
    waitedMin: number;
};

export function waitedMs(facts: MoodFacts, now: number): number {
    return facts.oldest?.since > 0 ? Math.max(0, now - facts.oldest.since) : 0;
}

// Concerned, then impatient, then attentive, then satisfied; neutral when none holds.
export function moodOf(memory: MoodMemory, facts: MoodFacts, now: number): MoodView {
    const waited = waitedMs(facts, now);
    const satisfied = within(memory.satisfiedAt, now, SatisfiedMs);
    let mood: Mood = "neutral";
    if (facts.failing) {
        mood = "concerned";
    } else if (waited >= ImpatientAfterMs[0]) {
        mood = "impatient";
    } else if (facts.waiting > 0) {
        mood = "attentive";
    } else if (satisfied) {
        mood = "satisfied";
    }
    return {
        mood,
        tired: isNight(now),
        relieved: !facts.failing && within(memory.reliefAt, now, ReliefMs),
        satisfiedMention: satisfied && within(memory.satisfiedAt, now, SatisfiedMentionMs),
        waitedMin: mood === "impatient" ? Math.floor(waited / 60000) : 0,
    };
}

// The expression a mood plays when the screen or the card opens, once, and at most every ReplayEveryMs.
export function replayOf(memory: MoodMemory, view: MoodView, now: number): BrokkExpression {
    if (within(memory.replayedAt, now, ReplayEveryMs)) {
        return null;
    }
    if (view.mood === "concerned") {
        return "frown";
    }
    if (view.mood === "impatient") {
        return "doubtful";
    }
    return view.satisfiedMention ? "smile" : null;
}

export type WaitRow = { key: string; since: number };

export type DueWaits = {
    // The rows whose wait just crossed a limit that was not told yet, with that limit.
    due: { key: string; afterMs: number }[];
    // When the next limit is crossed, or null when none will be.
    nextAt: number;
};

// The doubtful looks owed: each limit once per row, the highest limit crossed when several were.
export function dueWaits(rows: WaitRow[], told: Record<string, number>, now: number): DueWaits {
    const due: { key: string; afterMs: number }[] = [];
    let nextAt: number = null;
    for (const row of rows) {
        if (!(row.since > 0)) {
            continue;
        }
        const done = told[row.key] ?? 0;
        const crossed = ImpatientAfterMs.filter((limit) => row.since + limit <= now && limit > done);
        if (crossed.length > 0) {
            due.push({ key: row.key, afterMs: crossed[crossed.length - 1] });
        }
        const next = ImpatientAfterMs.find((limit) => row.since + limit > now);
        if (next != null && (nextAt == null || row.since + next < nextAt)) {
            nextAt = row.since + next;
        }
    }
    return { due, nextAt };
}
