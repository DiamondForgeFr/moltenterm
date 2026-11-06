// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's visits (FR-BOSS-009, AC2 to AC8 and AC11, #2001): when he comes to fetch the developer, with which face, and
// what "Plus tard" does. One visit at a time: whatever is pending when he comes is one visit, the gravest event sets his
// face, an event handled elsewhere is cancelled, and a visit pushed back with Plus tard stays away, whatever arrives,
// until its delay is over; then he comes once for everything.
//
// It knows no surface. A source raises or cancels an event by its key (or gives its whole set with `sync`), the
// surface tells what happens in the sidebar (brokk-gate.ts), and `brokkAfter` answers with what to show, whether the
// badge carries a soft cue, how many events the badge counts, and when to call it again. Pure and driven by the clock
// it is handed, so the rules are tested without a wait: the surface only sets a timer for the moment it is told.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import type { BrokkExpression } from "./brokk-ask-model";
import { EmptyGate, gateAfter, GateEvent, gateHold, gateOpensAt, GateState, mayArriveNow } from "./brokk-gate";
import { inQuietHours, nextClockTime, nextQuietChange } from "./brokk-mood";
import { severest, Severity, SeverityExpression, SeverityRank } from "./brokk-queue";
import {
    BrokkEvent,
    comingOf,
    DefaultVisitSettings,
    eventMoments,
    isRaised,
    severityOf,
    VisitSettings,
} from "./brokk-visit-events";

const Min = 60 * 1000;

// "Plus tard": when to come back. The clock times are fixed: this evening is 18:00, tomorrow morning is 09:00.
export type SnoozeChoiceId = "5min" | "15min" | "1h" | "tonight" | "tomorrow";

export const EveningMinute = 18 * 60;
export const MorningMinute = 9 * 60;
// A clock time closer than this is not offered: it would hardly be later than the hour.
export const MinClockLeadMs = 60 * Min;

export type SnoozeMenu = { choices: SnoozeChoiceId[]; escape: SnoozeChoiceId };

const GraveMenu: SnoozeMenu = { choices: ["5min", "15min", "1h"], escape: "5min" };
const ImportantMenu: SnoozeMenu = { choices: ["15min", "1h", "tonight"], escape: "15min" };
const CalmMenu: SnoozeMenu = { choices: ["1h", "tonight", "tomorrow"], escape: "1h" };

// The delays depend on how grave the visit is, and Escape takes the first, the default of its severity. Good news waits
// as long as a call does.
export function snoozeMenuOf(severity: Severity): SnoozeMenu {
    switch (severity) {
        case "grave":
            return GraveMenu;
        case "important":
            return ImportantMenu;
        default:
            return CalmMenu;
    }
}

const FixedDelaysMs: Partial<Record<SnoozeChoiceId, number>> = { "5min": 5 * Min, "15min": 15 * Min, "1h": 60 * Min };

// When the choice ends, or null when it is not available now: this evening, once it is an hour away or less, or past.
// Tomorrow morning is the next 09:00 more than an hour away, so that asked at 02:00 it means the morning coming.
export function snoozeUntil(choice: SnoozeChoiceId, now: number): number {
    const delay = FixedDelaysMs[choice];
    if (delay != null) {
        return now + delay;
    }
    if (choice === "tonight") {
        const evening = nextClockTime(now + MinClockLeadMs, EveningMinute);
        return new Date(evening).toDateString() === new Date(now).toDateString() ? evening : null;
    }
    return nextClockTime(now + MinClockLeadMs, MorningMinute);
}

export type SnoozeChoice = { id: SnoozeChoiceId; until: number };

// The choices the menu offers at this moment, in order, each with the moment it would end.
export function snoozeChoices(severity: Severity, now: number): SnoozeChoice[] {
    return snoozeMenuOf(severity)
        .choices.map((id) => ({ id, until: snoozeUntil(id, now) }))
        .filter((choice) => choice.until != null);
}

export type StoredEvent = { event: BrokkEvent; source: string };

export type VisitState = {
    // Every event not handled yet, by key.
    events: Record<string, StoredEvent>;
    // The severity rank each event was last told at, when the developer opened Brokk's panel on it: it is not told again
    // unless it grows graver.
    told: Record<string, number>;
    // No new visit before this moment (Plus tard), 0 when none.
    laterUntil: number;
    // He is there: the scene is up.
    shown: boolean;
};

export const EmptyVisits: VisitState = { events: {}, told: {}, laterUntil: 0, shown: false };

export type BrokkModel = { settings: VisitSettings; gate: GateState; visits: VisitState };

export const InitialBrokk: BrokkModel = { settings: DefaultVisitSettings, gate: EmptyGate, visits: EmptyVisits };

// What the visit says: his face, how grave it is, and the events it covers, the gravest first.
export type Visit = { severity: Severity; expression: BrokkExpression; keys: string[]; count: number };

function byGravity(settings: VisitSettings, now: number) {
    return (a: StoredEvent, b: StoredEvent): number =>
        SeverityRank[severityOf(b.event, settings, now)] - SeverityRank[severityOf(a.event, settings, now)] ||
        a.event.since - b.event.since ||
        (a.event.key < b.event.key ? -1 : 1);
}

// The events a visit would tell: set to Vient, worth a visit already, and not told at this gravity.
export function tellable(visits: VisitState, settings: VisitSettings, now: number): StoredEvent[] {
    return Object.values(visits.events)
        .filter(
            ({ event }) =>
                comingOf(event.kind, settings) === "vient" &&
                isRaised(event, settings, now) &&
                (visits.told[event.key] ?? -1) < SeverityRank[severityOf(event, settings, now)]
        )
        .sort(byGravity(settings, now));
}

export function visitOf(events: StoredEvent[], settings: VisitSettings, now: number): Visit {
    if (events.length === 0) {
        return null;
    }
    const severity = severest(events.map(({ event }) => severityOf(event, settings, now)));
    return {
        severity,
        expression: SeverityExpression[severity],
        keys: events.map(({ event }) => event.key),
        count: events.length,
    };
}

// What the badge counts: every event not set to Rien, told or not.
export function badgeCount(visits: VisitState, settings: VisitSettings): number {
    return Object.values(visits.events).filter(({ event }) => comingOf(event.kind, settings) !== "rien").length;
}

export type BrokkInput =
    // One event began. Raising a key again is the same event.
    | { type: "raise"; event: BrokkEvent; source?: string }
    // An event was handled elsewhere (the developer answered the agent), or is gone.
    | { type: "cancel"; key: string }
    // A source tells its whole set: its events that are not in it any more are cancelled.
    | { type: "sync"; source: string; events: BrokkEvent[] }
    // "Plus tard" on the visit that is up; "escape" takes the default delay of its severity.
    | { type: "later"; choice: SnoozeChoiceId | "escape" }
    // The developer opened Brokk's panel, from the scene or from the avatar: what was waiting is told.
    | { type: "open" }
    | { type: "settings"; settings: VisitSettings }
    | { type: "gate"; event: GateEvent }
    | { type: "tick" };

// The state after an event is raised: the very same object when it is known as it is, so that no one draws again for
// it. An event that changes kind under its key (an agent that waited, now in error) is a new one and is told again.
function withEvent(visits: VisitState, event: BrokkEvent, source: string, now: number): VisitState {
    const before = visits.events[event.key];
    const sameEpisode = before != null && before.event.kind === event.kind;
    const since = sameEpisode && before.event.since > 0 ? before.event.since : event.since > 0 ? event.since : now;
    if (sameEpisode && before.source === source && before.event.since === since && before.event.level === event.level) {
        return visits;
    }
    const told = { ...visits.told };
    if (!sameEpisode) {
        delete told[event.key];
    }
    return { ...visits, events: { ...visits.events, [event.key]: { event: { ...event, since }, source } }, told };
}

function withoutEvent(visits: VisitState, key: string): VisitState {
    if (visits.events[key] == null && visits.told[key] == null) {
        return visits;
    }
    const events = { ...visits.events };
    const told = { ...visits.told };
    delete events[key];
    delete told[key];
    return { ...visits, events, told };
}

function visitsAfter(visits: VisitState, input: BrokkInput, settings: VisitSettings, now: number): VisitState {
    switch (input.type) {
        case "raise":
            return withEvent(visits, input.event, input.source ?? "", now);
        case "cancel":
            return withoutEvent(visits, input.key);
        case "sync": {
            const listed = new Set(input.events.map((event) => event.key));
            let next = visits;
            for (const { event, source } of Object.values(visits.events)) {
                if (source === input.source && !listed.has(event.key)) {
                    next = withoutEvent(next, event.key);
                }
            }
            return input.events.reduce((current, event) => withEvent(current, event, input.source, now), next);
        }
        case "later": {
            const visit = visits.shown ? visitOf(tellable(visits, settings, now), settings, now) : null;
            if (visit == null) {
                return visits;
            }
            const menu = snoozeMenuOf(visit.severity);
            const id = input.choice !== "escape" && menu.choices.includes(input.choice) ? input.choice : menu.escape;
            return { ...visits, shown: false, laterUntil: snoozeUntil(id, now) ?? snoozeUntil(menu.escape, now) };
        }
        case "open": {
            const told = { ...visits.told };
            for (const { event } of tellable(visits, settings, now)) {
                told[event.key] = SeverityRank[severityOf(event, settings, now)];
            }
            return { ...visits, told, shown: false };
        }
        default:
            return visits;
    }
}

function quietNow(model: BrokkModel, now: number): boolean {
    return inQuietHours(model.settings.quiet, now);
}

// His arrival and departure follow from the state, after every input: he leaves when nothing is left to tell (or when
// the developer turned him off), and comes when something is, nothing holds him and the gate is open. Quiet hours
// beginning do not take back a scene that is already up.
function settled(model: BrokkModel, now: number): BrokkModel {
    let visits = model.visits;
    if (visits.laterUntil > 0 && now >= visits.laterUntil) {
        visits = { ...visits, laterUntil: 0 };
    }
    const waiting = tellable(visits, model.settings, now).length > 0;
    if (visits.shown && (!waiting || model.settings.never)) {
        visits = { ...visits, shown: false };
    } else if (
        !visits.shown &&
        waiting &&
        !model.settings.never &&
        visits.laterUntil === 0 &&
        mayArriveNow(model.gate, quietNow(model, now), now)
    ) {
        visits = { ...visits, shown: true };
    }
    return visits === model.visits ? model : { ...model, visits };
}

export type BrokkView = {
    // The visit that is up, or null.
    visit: Visit;
    // Something waits to be told but he holds back (the gate, not Plus tard or a setting): the badge carries a soft cue.
    cue: boolean;
    // He may start a visit now, whether or not something waits.
    mayArrive: boolean;
    // How many events the badge counts.
    badge: number;
    laterUntil: number;
};

export type BrokkStep = {
    model: BrokkModel;
    view: BrokkView;
    // When to call `tick`, or null when nothing changes by itself.
    wakeAt: number;
};

function viewOf(model: BrokkModel, now: number): BrokkView {
    const { visits, settings } = model;
    const waiting = tellable(visits, settings, now);
    const quiet = quietNow(model, now);
    return {
        visit: visits.shown ? visitOf(waiting, settings, now) : null,
        cue:
            !visits.shown &&
            waiting.length > 0 &&
            !settings.never &&
            visits.laterUntil === 0 &&
            !quiet &&
            gateHold(model.gate, false, now) != null,
        mayArrive: mayArriveNow(model.gate, quiet, now),
        badge: badgeCount(visits, settings),
        laterUntil: visits.laterUntil,
    };
}

// The next moment the answer can change by itself: a blocked agent reaching its threshold or its gravest point, the end
// of Plus tard, and, for a visit that is held back, the gate opening or the quiet hours ending. An event (an input)
// changes the rest.
function wakeOf(model: BrokkModel, now: number): number {
    const { visits, settings } = model;
    if (settings.never) {
        return null;
    }
    const moments: number[] = [];
    if (visits.laterUntil > now) {
        moments.push(visits.laterUntil);
    }
    for (const { event } of Object.values(visits.events)) {
        if (comingOf(event.kind, settings) === "vient") {
            moments.push(...eventMoments(event, settings));
        }
    }
    const held = !visits.shown && visits.laterUntil === 0 && tellable(visits, settings, now).length > 0;
    if (held) {
        moments.push(gateOpensAt(model.gate, now));
        if (quietNow(model, now)) {
            moments.push(nextQuietChange(settings.quiet, now));
        }
    }
    const future = moments.filter((at) => at != null && at > now);
    return future.length === 0 ? null : Math.min(...future);
}

export function brokkAfter(before: BrokkModel, input: BrokkInput, now: number): BrokkStep {
    let model = before;
    if (input.type === "settings") {
        model = { ...model, settings: input.settings };
    } else if (input.type === "gate") {
        model = { ...model, gate: gateAfter(model.gate, input.event, now) };
    } else {
        const visits = visitsAfter(model.visits, input, model.settings, now);
        model = visits === model.visits ? model : { ...model, visits };
    }
    model = settled(model, now);
    return { model, view: viewOf(model, now), wakeAt: wakeOf(model, now) };
}
