// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the views and the windows of this computer share of Brokk's visits (FR-BOSS-009, #2002). Each view of a window
// is its own page with its own model, and the developer switches between them all the time: without this, a visit
// pushed back with Plus tard in one view would play again in the next one, and what the developer already heard would
// be told again. Only two things are shared: the moment before which he does not come, and which events were told at
// which gravity. Pure, so the rules are tested without a window; brokk-hub-store.ts keeps it in the local storage.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import type { VisitState } from "./brokk-visit";

export const VisitShareKey = "moltenterm:brokk-visit";

// A told mark outlives the event by a day at most: the shared record must not grow for ever.
export const ToldKeepMs = 24 * 60 * 60 * 1000;

// A mark says at which gravity an event was told, and when. The last word wins, by its time: an event that ended leaves a
// mark of rank -1 (a tombstone), so that the same agent waiting again later, under the same key, is a new event that is
// told again, and a view that still has the old mark in memory does not bring it back.
export type SharedTold = { rank: number; at: number };

export const ForgottenRank = -1;

export type SharedVisit = {
    // No new visit before this moment, 0 when none.
    laterUntil: number;
    told: Record<string, SharedTold>;
};

export const EmptyShared: SharedVisit = { laterUntil: 0, told: {} };

function finite(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function prune(told: Record<string, SharedTold>, now: number): Record<string, SharedTold> {
    const kept: Record<string, SharedTold> = {};
    for (const [key, mark] of Object.entries(told)) {
        if (now - mark.at < ToldKeepMs) {
            kept[key] = mark;
        }
    }
    return kept;
}

// What the storage holds, read defensively: anything odd is empty.
export function readShared(raw: unknown, now: number): SharedVisit {
    let value: any = raw;
    if (typeof raw === "string") {
        try {
            value = JSON.parse(raw);
        } catch {
            return EmptyShared;
        }
    }
    if (value == null || typeof value !== "object") {
        return EmptyShared;
    }
    const told: Record<string, SharedTold> = {};
    if (value.told != null && typeof value.told === "object") {
        for (const [key, mark] of Object.entries(value.told as Record<string, any>)) {
            const rank = (mark as any)?.rank;
            if (typeof rank === "number" && Number.isInteger(rank) && rank >= ForgottenRank && rank <= 3) {
                told[key] = { rank, at: finite((mark as any)?.at) };
            }
        }
    }
    return { laterUntil: finite(value.laterUntil), told: prune(told, now) };
}

export function sharedText(shared: SharedVisit): string {
    return JSON.stringify(shared);
}

export function sameShared(a: SharedVisit, b: SharedVisit): boolean {
    if (a === b) {
        return true;
    }
    const keys = Object.keys(a.told);
    return (
        a.laterUntil === b.laterUntil &&
        keys.length === Object.keys(b.told).length &&
        keys.every((key) => b.told[key]?.rank === a.told[key].rank && b.told[key]?.at === a.told[key].at)
    );
}

// Two shared records in one: the later delay, and per event the later mark (the graver one at the same moment).
export function mergeShared(a: SharedVisit, b: SharedVisit, now: number): SharedVisit {
    const told = { ...a.told };
    for (const [key, mark] of Object.entries(b.told)) {
        const known = told[key];
        if (known == null || mark.at > known.at || (mark.at === known.at && mark.rank > known.rank)) {
            told[key] = mark;
        }
    }
    const later = Math.max(a.laterUntil, b.laterUntil);
    const next: SharedVisit = { laterUntil: later > now ? later : 0, told: prune(told, now) };
    return sameShared(next, a) ? a : next;
}

// What this view knows added to what is shared: the later of the two delays, and the marks of the events it holds that are
// graver than what is shared says of them. A delay that is over is not kept.
export function publishOf(shared: SharedVisit, visits: VisitState, now: number): SharedVisit {
    const told: Record<string, SharedTold> = {};
    for (const [key, rank] of Object.entries(visits.told)) {
        if (visits.events[key] != null && (shared.told[key]?.rank ?? ForgottenRank) < rank) {
            told[key] = { rank, at: now };
        }
    }
    return mergeShared(shared, { laterUntil: visits.laterUntil, told }, now);
}

// Events that ended: what was told of them is forgotten, for every view, so that the same key raised again is new. The
// very same record when nothing was told of them.
export function forgetIn(shared: SharedVisit, keys: string[], now: number): SharedVisit {
    const told = { ...shared.told };
    let changed = false;
    for (const key of keys) {
        if ((told[key]?.rank ?? ForgottenRank) > ForgottenRank) {
            told[key] = { rank: ForgottenRank, at: now };
            changed = true;
        }
    }
    return changed ? { ...shared, told } : shared;
}

// What this view takes from what is shared: a delay started elsewhere (the scene that is up folds), and the marks of the
// events it knows. The very same object when it takes nothing.
export function adoptInto(visits: VisitState, shared: SharedVisit, now: number): VisitState {
    let next = visits;
    if (shared.laterUntil > now && shared.laterUntil > visits.laterUntil) {
        next = { ...next, laterUntil: shared.laterUntil, shown: false };
    }
    let told = next.told;
    for (const key of Object.keys(next.events)) {
        const mark = shared.told[key];
        if (mark != null && mark.rank > (told[key] ?? -1)) {
            told = told === next.told ? { ...told } : told;
            told[key] = mark.rank;
        }
    }
    return told === next.told ? next : { ...next, told };
}
