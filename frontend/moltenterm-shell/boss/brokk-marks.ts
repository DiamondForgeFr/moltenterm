// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the developer did with Brokk, kept once for every page (FR-BOSS-009, AC105, AC106, #2391). Each tab of MoltenTerm
// is a page of its own, and a page's memory is its own: kept there, the moment he was last opened, the rows set aside
// with Later, the update and the plan usage he showed and his mood made each workspace count another badge. They live in
// the client's meta instead, which every page reads and wavesrv keeps across restarts (as brokk-visit-words-store.ts
// keeps his words). Each value is merged rather than overwritten where two pages could write it at once. Pure, so the
// rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

// The last moment the developer opened his group, anywhere (Unix ms): what finished, ended or was offered before it is
// heard.
export const HeardMetaKey = "moltenterm:brokkheard";
// The rows set aside with Later, until the group is next opened.
export const ParkedMetaKey = "moltenterm:brokkparked";
// The rows settled or ignored (boss-handled.ts).
export const HandledMetaKey = "moltenterm:brokkhandled";
// The update offer he showed (its card's key), and the providers whose plan usage he showed.
export const UpdateSeenMetaKey = "moltenterm:brokkupdateseen";
export const UsageSeenMetaKey = "moltenterm:brokkusageseen";
// His mood's memory (brokk-mood.ts), with the moment it was written.
export const MoodMetaKey = "moltenterm:brokkmood";

export const MarksMetaKeys = [
    HeardMetaKey,
    ParkedMetaKey,
    HandledMetaKey,
    UpdateSeenMetaKey,
    UsageSeenMetaKey,
    MoodMetaKey,
] as const;

export type MarksMeta = Record<string, unknown>;

function finite(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function parsed(raw: unknown): any {
    if (typeof raw !== "string") {
        return raw;
    }
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export function readHeard(raw: unknown): number {
    return finite(raw);
}

// ---- Later ------------------------------------------------------------------------------------------------------------

// A row set aside stays aside while its mark is later than the last opening: the opening of any page gives every row
// back, and a Later in one page and an opening in another, written at once, both keep their order.
export type ParkedMarks = { clearedAt: number; keys: Record<string, number> };

export const EmptyParked: ParkedMarks = { clearedAt: 0, keys: {} };

export function readParked(raw: unknown): ParkedMarks {
    const value = parsed(raw);
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return EmptyParked;
    }
    const clearedAt = finite(value.clearedAt);
    const keys: Record<string, number> = {};
    if (value.keys != null && typeof value.keys === "object") {
        for (const [key, at] of Object.entries(value.keys as Record<string, unknown>)) {
            if (finite(at) > clearedAt) {
                keys[key] = finite(at);
            }
        }
    }
    return { clearedAt, keys };
}

export function parkedText(parked: ParkedMarks): string {
    return JSON.stringify(parked);
}

export function parkRow(parked: ParkedMarks, key: string, now: number): ParkedMarks {
    const at = Math.max(now, parked.clearedAt + 1);
    return { clearedAt: parked.clearedAt, keys: { ...parked.keys, [key]: at } };
}

export function clearParked(parked: ParkedMarks, now: number): ParkedMarks {
    return { clearedAt: Math.max(now, parked.clearedAt), keys: {} };
}

// The rows set aside now, as the To handle list reads them.
export function parkedKeysOf(parked: ParkedMarks): Record<string, boolean> {
    const rtn: Record<string, boolean> = {};
    for (const key of Object.keys(parked.keys)) {
        rtn[key] = true;
    }
    return rtn;
}

// ---- what he showed ---------------------------------------------------------------------------------------------------

export function readUpdateSeen(raw: unknown): string {
    return typeof raw === "string" ? raw : "";
}

// The providers seen, as brokk-extra-feeds.ts writes them (usageMemoryText); "" when none.
export function readUsageSeen(raw: unknown): string {
    return typeof raw === "string" ? raw : "";
}

// ---- his mood ---------------------------------------------------------------------------------------------------------

export type SharedMood<T> = { at: number; memory: T };

// The mood as the meta holds it, null when there is none or it cannot be read.
export function readMood<T>(raw: unknown): SharedMood<T> {
    const value = parsed(raw);
    if (value == null || typeof value !== "object" || finite(value.at) === 0) {
        return null;
    }
    const memory = value.memory;
    if (memory == null || typeof memory !== "object" || !Array.isArray(memory.log) || typeof memory.told !== "object") {
        return null;
    }
    return { at: finite(value.at), memory: memory as T };
}

export function moodText<T>(mood: SharedMood<T>): string {
    return JSON.stringify(mood);
}
