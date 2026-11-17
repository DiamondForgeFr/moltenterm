// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk as a kind colleague (FR-BOSS-009, AC71 to AC78, #2203): the benevolent moments he can say under his square, from
// local signals only (the clock, the developer's inputs, the agents at work). Pure and driven by the clock it is handed,
// so every trigger and limit is tested without a wait. These moments are not events that bring him (FR-BOSS-009, AC29):
// nothing here knows the hub, a visit or a gesture, and a moment only ever shows in the line the group opens with.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

export type MomentKind = "hello" | "break" | "handover";

// How near Brokk stands (FR-BOSS-009, AC75). An ordered scale that grows: 1.1.0 adds Close and Partner after Colleague
// (#2156), so every rule asks "at least this close" and never "is it on".
export const Proximities = ["discreet", "colleague"] as const;
export type Proximity = (typeof Proximities)[number];
export const DefaultProximity: Proximity = "colleague";
export const ProximitySettingKey = "boss:proximity";

export function proximityOf(value: unknown): Proximity {
    return Proximities.includes(value as Proximity) ? (value as Proximity) : DefaultProximity;
}

export function atLeast(level: Proximity, floor: Proximity): boolean {
    return Proximities.indexOf(level) >= Proximities.indexOf(floor);
}

// Colleague is the first level that has moments and the first that lets his model phrase them.
export function momentsOn(level: Proximity): boolean {
    return atLeast(level, "colleague");
}

export function modelPhrasingOn(level: Proximity): boolean {
    return atLeast(level, "colleague");
}

const Min = 60 * 1000;
const Hour = 60 * Min;

// A pause this long ends a stretch of continuous activity.
export const PauseMs = 15 * Min;
export const BreakAfterMs = 2 * Hour;
// The hello greets the first activity after the night or a long absence, not a lunch break.
export const LongAbsenceMs = 4 * Hour;
// A moment nobody looked at lapses: a greeting is for the moment the developer sits down.
export const HelloLifeMs = Hour;
export const BreakLifeMs = 45 * Min;
// The evening runs from this hour to the other, local time.
export const EveningFromHour = 21;
export const EveningToHour = 5;
// Evaluation by the clock alone, while the developer has made no input.
export const TickMs = Min;

export type HelloPart = "early" | "morning" | "lateMorning" | "back";
export const HelloParts: HelloPart[] = ["early", "morning", "lateMorning", "back"];

// The phrasings of a set, written in locales/en.json and fr.json as boss.moment.<set>.p1 to pN.
export const HelloPhrasings = 5;
export const MomentPhrasings = 20;

// Between midnight and the end of the evening (EveningToHour) no hello is raised (helloHours): a late return is still the
// evening, never a dawn.
export function helloPartOf(now: number): HelloPart {
    const hour = new Date(now).getHours();
    if (hour < EveningToHour) {
        return "back";
    }
    if (hour < 7) {
        return "early";
    }
    if (hour < 10) {
        return "morning";
    }
    return hour < 12 ? "lateMorning" : "back";
}

export function phraseSet(kind: MomentKind, part?: HelloPart): string {
    return kind === "hello" ? `hello.${part ?? "back"}` : kind;
}

export function setSize(set: string): number {
    return set.startsWith("hello.") ? HelloPhrasings : MomentPhrasings;
}

export function phraseKey(set: string, index: number): string {
    return `boss.moment.${set}.p${index + 1}`;
}

export function allPhraseKeys(): string[] {
    const sets = [...HelloParts.map((part) => phraseSet("hello", part)), phraseSet("break"), phraseSet("handover")];
    return sets.flatMap((set) => Array.from({ length: setSize(set) }, (_, i) => phraseKey(set, i)));
}

// A random phrasing of the set that is not the one shown the previous time.
export function pickIndex(size: number, last: number, random: () => number): number {
    if (size <= 1) {
        return 0;
    }
    const known = Number.isInteger(last) && last >= 0 && last < size;
    const pool = known ? size - 1 : size;
    const pick = Math.min(Math.floor(random() * pool), pool - 1);
    return known && pick >= last ? pick + 1 : pick;
}

function two(n: number): string {
    return String(n).padStart(2, "0");
}

export function dayKey(now: number): string {
    const date = new Date(now);
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

export function clockOf(now: number): string {
    const date = new Date(now);
    return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function isEvening(now: number): boolean {
    const hour = new Date(now).getHours();
    return hour >= EveningFromHour || hour < EveningToHour;
}

// The evening a time belongs to: one o'clock in the morning is still the evening that began the day before.
export function eveningKey(now: number): string {
    return dayKey(now - EveningToHour * Hour);
}

// The day a hello belongs to turns when the evening ends, not at midnight (#2216): an input at half past midnight must not
// greet the morning that follows.
export function helloDayKey(now: number): string {
    return eveningKey(now);
}

export function helloHours(now: number): boolean {
    return new Date(now).getHours() >= EveningToHour;
}

export type Moment = {
    id: string;
    kind: MomentKind;
    set: string;
    // The written phrasing, an index of the set.
    index: number;
    raisedAt: number;
    // The local time it was raised at, what his model is told.
    clock: string;
    // Break: the stretch it belongs to, and how long it had lasted, in minutes.
    stretchStart?: number;
    workedMin?: number;
    // Hand-over: the agents at work when it was raised.
    agents?: number;
    // The line his model wrote, kept only when it came before the moment was first shown.
    line?: string;
    shownAt?: number;
};

export type ColleagueMemory = {
    // Kept across restarts (encodeMemory).
    helloDay: string;
    last: Record<string, number>;
    handoverEvening: string;
    // The last time the developer was known at this computer: an input in a view, or this computer's idle time. What the
    // hello's absence is measured from, so that a restart or a rebuilt view is not an absence (#2216).
    presentAt: number;
    // For a run of the window.
    lastInputAt: number;
    stretchStart: number;
    nudgedStretch: number;
    moments: Moment[];
};

export const EmptyColleague: ColleagueMemory = {
    helloDay: "",
    last: {},
    handoverEvening: "",
    presentAt: null,
    lastInputAt: null,
    stretchStart: null,
    nudgedStretch: null,
    moments: [],
};

export type ColleagueFacts = {
    now: number;
    proximity: Proximity;
    // The agents at work now.
    working: number;
    random: () => number;
};

type MomentSeed = Pick<Moment, "kind" | "set"> & Partial<Pick<Moment, "stretchStart" | "workedMin" | "agents">>;

function raise(memory: ColleagueMemory, seed: MomentSeed, facts: ColleagueFacts): ColleagueMemory {
    const index = pickIndex(setSize(seed.set), memory.last[seed.set], facts.random);
    const moment: Moment = {
        ...seed,
        id: `${seed.kind}:${facts.now}`,
        index,
        raisedAt: facts.now,
        clock: clockOf(facts.now),
    };
    return {
        ...memory,
        last: { ...memory.last, [seed.set]: index },
        moments: [...memory.moments, moment],
    };
}

function active(memory: ColleagueMemory, now: number): boolean {
    return memory.lastInputAt != null && now - memory.lastInputAt < PauseMs;
}

function lapsed(moment: Moment, memory: ColleagueMemory, facts: ColleagueFacts): boolean {
    const age = facts.now - moment.raisedAt;
    switch (moment.kind) {
        case "hello":
            if (moment.shownAt != null) {
                return facts.now - moment.shownAt >= HelloLifeMs;
            }
            // Never shown: it waits for its first chance to show, for the rest of its day, unless another window greeted
            // that day (#2217).
            return (
                helloDayKey(facts.now) !== helloDayKey(moment.raisedAt) ||
                memory.helloDay === helloDayKey(moment.raisedAt)
            );
        case "break":
            return age >= BreakLifeMs || !active(memory, facts.now) || memory.stretchStart !== moment.stretchStart;
        case "handover":
            return facts.working === 0 || !isEvening(facts.now);
        default:
            return true;
    }
}

// Moments that no longer hold go; the same list when none does, so that no one draws again for it.
function withoutLapsed(memory: ColleagueMemory, facts: ColleagueFacts): ColleagueMemory {
    const kept = memory.moments.filter((moment) => !lapsed(moment, memory, facts));
    if (!momentsOn(facts.proximity)) {
        return memory.moments.length === 0 ? memory : { ...memory, moments: [] };
    }
    return kept.length === memory.moments.length ? memory : { ...memory, moments: kept };
}

function has(memory: ColleagueMemory, kind: MomentKind): boolean {
    return memory.moments.some((moment) => moment.kind === kind);
}

// The moments the clock and the agents owe now: the break at the end of a long stretch, the hand-over in the evening.
export function evaluate(memory: ColleagueMemory, facts: ColleagueFacts): ColleagueMemory {
    let next = withoutLapsed(memory, facts);
    if (!momentsOn(facts.proximity) || !active(next, facts.now)) {
        return next;
    }
    const { now } = facts;
    if (
        next.stretchStart != null &&
        now - next.stretchStart >= BreakAfterMs &&
        next.nudgedStretch !== next.stretchStart &&
        !has(next, "break")
    ) {
        next = raise(
            { ...next, nudgedStretch: next.stretchStart },
            {
                kind: "break",
                set: phraseSet("break"),
                stretchStart: next.stretchStart,
                workedMin: Math.floor((now - next.stretchStart) / Min),
            },
            facts
        );
    }
    if (isEvening(now) && facts.working > 0 && next.handoverEvening !== eveningKey(now) && !has(next, "handover")) {
        next = raise(
            { ...next, handoverEvening: eveningKey(now) },
            { kind: "handover", set: phraseSet("handover"), agents: facts.working },
            facts
        );
    }
    return next;
}

// The developer is at this computer at `at`: an input in a view, or this computer's idle time read by the clock. The first
// presence of the day after a long absence is greeted. A wake read by the idle time before any input in a view is that
// presence too, or the input that follows would find no absence left (#2216).
export function afterPresence(memory: ColleagueMemory, at: number, facts: ColleagueFacts): ColleagueMemory {
    if (at == null || !Number.isFinite(at) || (memory.presentAt != null && at <= memory.presentAt)) {
        return memory;
    }
    const absence = memory.presentAt == null ? Infinity : at - memory.presentAt;
    // A moment nobody saw that has lapsed must not hold the place of the one this presence calls for.
    let next = withoutLapsed({ ...memory, presentAt: at }, facts);
    if (
        momentsOn(facts.proximity) &&
        absence >= LongAbsenceMs &&
        helloHours(at) &&
        next.helloDay !== helloDayKey(at) &&
        !has(next, "hello")
    ) {
        // The day counts as greeted once the line was on screen (afterShown), not now (#2217).
        next = raise(next, { kind: "hello", set: phraseSet("hello", helloPartOf(at)) }, facts);
    }
    return next;
}

// An input of the developer: it ends or continues a stretch, and the first one after the night is greeted.
export function afterInput(memory: ColleagueMemory, facts: ColleagueFacts): ColleagueMemory {
    const { now } = facts;
    const gap = memory.lastInputAt == null ? Infinity : now - memory.lastInputAt;
    const next = afterPresence(
        {
            ...memory,
            lastInputAt: now,
            stretchStart: gap >= PauseMs || memory.stretchStart == null ? now : memory.stretchStart,
        },
        now,
        facts
    );
    return evaluate(next, facts);
}

// The order the moments are shown in when several wait: a greeting is for the moment he sits down.
const ShowOrder: MomentKind[] = ["hello", "break", "handover"];

export function currentMoment(moments: Moment[]): Moment {
    for (const kind of ShowOrder) {
        const found = moments.find((moment) => moment.kind === kind);
        if (found != null) {
            return found;
        }
    }
    return null;
}

// The moment is on screen: his model's line, if it comes after this, is too late and is left out. A hello greets its day
// now, and takes the written set of the part of the day it shows in, since it may have waited (#2217).
export function afterShown(memory: ColleagueMemory, id: string, now: number): ColleagueMemory {
    const moment = memory.moments.find((m) => m.id === id);
    if (moment == null || moment.shownAt != null) {
        return memory;
    }
    let shown: Moment = { ...moment, shownAt: now };
    let next = memory;
    if (moment.kind === "hello") {
        next = { ...memory, helloDay: helloDayKey(moment.raisedAt) };
        const set = phraseSet("hello", helloPartOf(now));
        if (set !== moment.set) {
            shown = { ...shown, set, line: undefined };
        }
    }
    return { ...next, moments: memory.moments.map((m) => (m.id === id ? shown : m)) };
}

// What decides whether the hello may show itself on the folded avatar (FR-BOSS-009, AC74, #2217).
export type HelloCueFacts = {
    // The avatar is mounted where it can be seen: the sidebar's row or the window's top edge, in a view on screen of a
    // window that shows. Not the collapsed strip, which is out of sight at rest.
    visible: boolean;
    quiet: boolean;
    groupOpen: boolean;
    // A visit scene stands in his place.
    sceneUp: boolean;
};

// The hello the avatar shows now, or null: only a hello, only one never shown, and only when nothing hides it.
export function helloCue(moments: Moment[], facts: HelloCueFacts): Moment {
    if (!facts.visible || facts.quiet || facts.groupOpen || facts.sceneUp) {
        return null;
    }
    return moments.find((moment) => moment.kind === "hello" && moment.shownAt == null) ?? null;
}

// The developer has seen it and the group or the bubble closed: a moment shows once. A hello seen has greeted its day.
export function afterSeen(memory: ColleagueMemory, id: string): ColleagueMemory {
    const moment = memory.moments.find((m) => m.id === id);
    if (moment == null) {
        return memory;
    }
    const next = moment.kind === "hello" ? { ...memory, helloDay: helloDayKey(moment.raisedAt) } : memory;
    return { ...next, moments: memory.moments.filter((m) => m.id !== id) };
}

// What the group does with the moment as it opens, stays open and closes. `kept` is the moment the group took when it
// showed, so that its words never change under the developer's eyes; `shown` is the id to tell the model it is on screen
// now; `seen` is the id to forget, because the group closed on it.
export type MomentStep = { kept: Moment; shown: string; seen: string };

export function momentStep(kept: Moment, current: Moment, groupShown: boolean): MomentStep {
    if (!groupShown) {
        return { kept, shown: null, seen: kept?.id ?? null };
    }
    if (kept != null || current == null) {
        return { kept, shown: null, seen: null };
    }
    return { kept: current, shown: current.id, seen: null };
}

// His model's line for a moment, when it arrives in time.
export function afterPhrased(memory: ColleagueMemory, id: string, line: string): ColleagueMemory {
    const moment = memory.moments.find((m) => m.id === id);
    if (moment == null || moment.shownAt != null || line == null || line === "") {
        return memory;
    }
    return { ...memory, moments: memory.moments.map((m) => (m.id === id ? { ...m, line } : m)) };
}

// The text a moment shows: his model's line, else the written phrasing, which the caller translates.
export function momentLine(moment: Moment): { key?: string; text?: string } {
    if (moment.line != null && moment.line !== "") {
        return { text: moment.line };
    }
    return { key: phraseKey(moment.set, moment.index) };
}

const MinLineChars = 6;
export const MaxLineChars = 120;
const Quotes = /^["'“”«»‘’]+|["'“”«»‘’]+$/g;
const MarkdownChars = /[*_`#<>[\]{}|~\\^]/;
const Links = /:\/\/|\bwww\.|@|\b[\w-]+\.(com|org|net|io|dev|app|fr|ai|co)\b/i;
// eslint-disable-next-line no-control-regex
const Controls = /[\u0000-\u0008\u000b-\u001f\u007f]/;

// The line his model wrote, or null when it is not fit to show: one line, short, with no markdown, no link and no digit
// (a number is the notification centre's). Nothing is repaired but the quotes some models put around a line.
export function validModelLine(text: unknown): string {
    if (typeof text !== "string") {
        return null;
    }
    const lines = text
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    if (lines.length !== 1) {
        return null;
    }
    const line = lines[0].replace(Quotes, "").trim();
    if (line.length < MinLineChars || line.length > MaxLineChars) {
        return null;
    }
    if (MarkdownChars.test(line) || Links.test(line) || /\d/.test(line) || Controls.test(line)) {
        return null;
    }
    return /^[-•–—]\s/.test(line) ? null : line;
}

// What is kept across restarts: which day he greeted, which phrasing came last, which evening he handed over, when the
// developer was last here. A run's stretches and moments are not. How many times his model was asked today is kept by
// wavesrv, where the call is made (pkg/molten/brokksession/phrase.go).
export type SavedColleague = Pick<ColleagueMemory, "helloDay" | "last" | "handoverEvening" | "presentAt">;

// The presence is saved to the minute, so that a developer at work changes the saved text, and writes it, once a minute
// at most.
export function savedPresence(at: number): number {
    return at == null ? null : Math.floor(at / Min) * Min;
}

export function encodeMemory(memory: ColleagueMemory): string {
    const saved: SavedColleague = {
        helloDay: memory.helloDay,
        last: memory.last,
        handoverEvening: memory.handoverEvening,
        presentAt: savedPresence(memory.presentAt),
    };
    return JSON.stringify(saved);
}

function textOf(value: unknown): string {
    return typeof value === "string" ? value : "";
}

export function decodeMemory(text: string): ColleagueMemory {
    let saved: Partial<Record<keyof SavedColleague, unknown>> = null;
    try {
        saved = JSON.parse(text);
    } catch {
        return EmptyColleague;
    }
    if (saved == null || typeof saved !== "object") {
        return EmptyColleague;
    }
    const last: Record<string, number> = {};
    for (const [set, index] of Object.entries((saved.last as Record<string, unknown>) ?? {})) {
        if (Number.isInteger(index) && (index as number) >= 0) {
            last[set] = index as number;
        }
    }
    const present = saved.presentAt;
    return {
        ...EmptyColleague,
        helloDay: textOf(saved.helloDay),
        last,
        handoverEvening: textOf(saved.handoverEvening),
        presentAt: typeof present === "number" && Number.isFinite(present) && present > 0 ? present : null,
    };
}
