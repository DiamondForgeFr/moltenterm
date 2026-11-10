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

import type { AgentSeenView } from "../agent-state-model";
import { eventSourceInView, NothingInView } from "../source-in-view";
import type { BrokkExpression } from "./brokk-ask-model";
import { EmptyGate, gateAfter, GateEvent, gateHold, gateOpensAt, GateState, mayArriveNow } from "./brokk-gate";
import type { PanelId } from "./brokk-group-model";
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
    // The events held back because their source is, or just was, in front of the developer (#2166): not before this
    // moment. Kept a little ahead while the source stays in view, and set to LeftViewDelayMs after it leaves.
    heldUntil?: Record<string, number>;
    // The events whose source was in view at the last step, to know when it leaves.
    inView?: string[];
};

export const EmptyVisits: VisitState = { events: {}, told: {}, laterUntil: 0, shown: false, heldUntil: {}, inView: [] };

// `view` is what this tab view shows (source-in-view.ts): what it shows of an event's source holds the event back.
export type BrokkModel = { settings: VisitSettings; gate: GateState; visits: VisitState; view?: AgentSeenView };

export const InitialBrokk: BrokkModel = {
    settings: DefaultVisitSettings,
    gate: EmptyGate,
    visits: EmptyVisits,
    view: NothingInView,
};

// How long an event stays held back once its source left the view (AC64): the developer who looked away without acting
// is fetched after this, once, as if it had just arrived.
export const LeftViewDelayMs = Min;

// A hold is renewed while its source stays in view once less than this is left of it (every 10 s), so that the other
// views and windows, which learn it through the shared record, keep holding. A view that stops listening as it hides
// cannot say the source left: the view the developer moves to then lets it go 50 to 60 s later.
export const HoldRenewMs = LeftViewDelayMs - 10 * 1000;

export function isHeld(visits: VisitState, key: string, now: number): boolean {
    return (visits.heldUntil?.[key] ?? 0) > now;
}

// The keys held back now, sorted.
export function heldKeys(visits: VisitState, now: number): string[] {
    return Object.keys(visits.heldUntil ?? {})
        .filter((key) => visits.events[key] != null && isHeld(visits, key, now))
        .sort();
}

function sameList(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameHolds(a: Record<string, number>, b: Record<string, number>): boolean {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

// The holds after a step (AC63, AC64): an event whose source is in view is held, and renewed while it stays there; one
// whose source just left stays held for LeftViewDelayMs from now; a hold that is over, or of an event that ended, goes.
function withHolds(visits: VisitState, view: AgentSeenView, now: number): VisitState {
    const before = visits.heldUntil ?? {};
    const wasInView = visits.inView ?? [];
    const inView = Object.keys(visits.events)
        .filter((key) => eventSourceInView(key, view))
        .sort();
    const held: Record<string, number> = {};
    for (const [key, until] of Object.entries(before)) {
        if (visits.events[key] != null && until > now) {
            held[key] = until;
        }
    }
    for (const key of inView) {
        if ((held[key] ?? 0) <= now + HoldRenewMs) {
            held[key] = now + LeftViewDelayMs;
        }
    }
    for (const key of wasInView) {
        if (visits.events[key] != null && !inView.includes(key)) {
            held[key] = now + LeftViewDelayMs;
        }
    }
    if (sameList(inView, wasInView) && sameHolds(held, before)) {
        return visits;
    }
    return { ...visits, heldUntil: held, inView };
}

// What the visit says: his face, how grave it is, and the events it covers, the gravest first.
export type Visit = {
    severity: Severity;
    expression: BrokkExpression;
    keys: string[];
    count: number;
    example?: boolean;
};

// The panel his click opens on, so that it names the reason (FR-BOSS-009, AC79, #2203): a download is in Downloads, a plan
// reading is the week grid that always stands under his square, and everything else is a card of the Notifications. null:
// no panel is asked, the group opens as it does for the avatar.
export function visitPanelOf(visit: Visit): PanelId {
    const key = visit?.keys[0];
    if (key == null || visit.example === true || key.startsWith("usage:")) {
        return null;
    }
    return key.startsWith("download:") ? "downloads" : "notifications";
}

// The visit of the settings' "Show a visit" (FR-BOSS-009, AC31 and AC32, #2079): the scene as a real one plays it, for an
// example event. It is never raised, counted, told or recorded, and the hub shows it on its own, past quiet hours.
export const ExampleVisit: Visit = {
    severity: "important",
    expression: SeverityExpression.important,
    keys: [],
    count: 1,
    example: true,
};

function byGravity(settings: VisitSettings, now: number) {
    return (a: StoredEvent, b: StoredEvent): number =>
        SeverityRank[severityOf(b.event, settings, now)] - SeverityRank[severityOf(a.event, settings, now)] ||
        a.event.since - b.event.since ||
        (a.event.key < b.event.key ? -1 : 1);
}

// The events a visit would tell: set to Vient, worth a visit already, not told at this gravity, and not held back by what
// the developer has in view (#2166) unless `withHeld`.
export function tellable(visits: VisitState, settings: VisitSettings, now: number, withHeld = false): StoredEvent[] {
    return Object.values(visits.events)
        .filter(
            ({ event }) =>
                comingOf(event.kind, settings) === "vient" &&
                isRaised(event, settings, now) &&
                (withHeld || !isHeld(visits, event.key, now)) &&
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

// What the badge counts: every event not set to Rien, told or not. Its keys are how the collapsed sidebar tells a new
// notification from one it already told (brokk-edge-model.ts).
export function badgeKeys(visits: VisitState, settings: VisitSettings): string[] {
    return Object.values(visits.events)
        .filter(({ event }) => comingOf(event.kind, settings) !== "rien")
        .map(({ event }) => event.key)
        .sort();
}

// The badge's keys set to Vient: the only ones that move the collapsed sidebar (#2155). With "never come" set, none; nor
// one held back by what the developer has in view (#2166).
export function comingKeys(visits: VisitState, settings: VisitSettings, now: number = 0): string[] {
    if (settings.never) {
        return [];
    }
    return Object.values(visits.events)
        .filter(({ event }) => comingOf(event.kind, settings) === "vient" && !isHeld(visits, event.key, now))
        .map(({ event }) => event.key)
        .sort();
}

export function badgeCount(visits: VisitState, settings: VisitSettings): number {
    return badgeKeys(visits, settings).length;
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
    // The developer gave these events back themselves (the undo of an archive, #2210): they are heard, as on opening.
    | { type: "heard"; keys: string[] }
    | { type: "settings"; settings: VisitSettings }
    | { type: "gate"; event: GateEvent }
    // What this tab view shows changed (source-in-view.ts).
    | { type: "view"; view: AgentSeenView }
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
    if (visits.events[key] == null && visits.told[key] == null && visits.heldUntil?.[key] == null) {
        return visits;
    }
    const events = { ...visits.events };
    const told = { ...visits.told };
    const heldUntil = { ...(visits.heldUntil ?? {}) };
    delete events[key];
    delete told[key];
    delete heldUntil[key];
    return { ...visits, events, told, heldUntil, inView: (visits.inView ?? []).filter((k) => k !== key) };
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
            // What is held back is heard too: the developer opened his panel on everything.
            for (const { event } of tellable(visits, settings, now, true)) {
                told[event.key] = SeverityRank[severityOf(event, settings, now)];
            }
            return { ...visits, told, shown: false };
        }
        case "heard": {
            let told = visits.told;
            for (const key of input.keys) {
                const known = visits.events[key];
                if (known == null) {
                    continue;
                }
                const rank = SeverityRank[severityOf(known.event, settings, now)];
                if ((told[key] ?? -1) < rank) {
                    told = told === visits.told ? { ...told } : told;
                    told[key] = rank;
                }
            }
            return told === visits.told ? visits : { ...visits, told };
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
    let visits = withHolds(model.visits, model.view ?? NothingInView, now);
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
    // How many events the badge counts, and which.
    badge: number;
    badgeKeys: string[];
    // Those of them set to Vient, which move the collapsed sidebar.
    comingKeys: string[];
    // Those held back by what the developer has in view (#2166): the collapsed sidebar does not count them as told, so
    // that it moves for them once they are let go.
    heldKeys: string[];
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
    const keys = badgeKeys(visits, settings);
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
        badge: keys.length,
        badgeKeys: keys,
        comingKeys: comingKeys(visits, settings, now),
        heldKeys: heldKeys(visits, now),
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
    const inView = new Set(visits.inView ?? []);
    for (const { event } of Object.values(visits.events)) {
        if (comingOf(event.kind, settings) !== "vient") {
            continue;
        }
        moments.push(...eventMoments(event, settings));
        const until = visits.heldUntil?.[event.key];
        if (until != null) {
            moments.push(inView.has(event.key) ? until - HoldRenewMs : until);
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
    } else if (input.type === "view") {
        model = { ...model, view: input.view ?? NothingInView };
    } else {
        const visits = visitsAfter(model.visits, input, model.settings, now);
        model = visits === model.visits ? model : { ...model, visits };
    }
    model = settled(model, now);
    return { model, view: viewOf(model, now), wakeAt: wakeOf(model, now) };
}
