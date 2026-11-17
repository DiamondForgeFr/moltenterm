// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How a visit varies its words (FR-BOSS-009, AC82, #2222): each reason a visit can have is a set of phrasings written in
// locales/en.json and fr.json as boss.visit.reason.<reason>.p1 to pN. One is drawn each time he comes for the reason and
// is never one of the last half of the set he said for it, so that the CI line, shown several times a day, is never the
// same sentence twice within a few visits. Pure and driven by the random source it is handed, so the rules are tested
// without a window; brokk-visit-words-store.ts keeps what was said across restarts and windows.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

// Between 4 and 6 phrasings a reason (tests keep the locales equal to this table). The rarer a reason, the fewer.
export const VisitPhrasings = {
    waitedFor: 5,
    waiting: 4,
    asks: 5,
    goAhead: 5,
    error: 5,
    ciFailed: 5,
    ready: 5,
    download: 4,
    update: 4,
    usage: 4,
    security: 4,
    other: 4,
} as const;

export type VisitReason = keyof typeof VisitPhrasings;

export const VisitReasons = Object.keys(VisitPhrasings) as VisitReason[];

export function wordingKey(reason: VisitReason, index: number): string {
    return `boss.visit.reason.${reason}.p${index + 1}`;
}

// A pick of the phrasing to say: `signature` is what identifies the visit's sentence (its reason and gravest event), so
// that the same visit keeps its words while it is up.
export type WordingPick = (reason: VisitReason, signature: string) => number;

export const FirstWording: WordingPick = () => 0;

// How many of the last phrasings said are kept out of the draw: half the set, rounded up, which always leaves at least
// two phrasings to draw from.
export function windowOf(size: number): number {
    return Math.ceil(size / 2);
}

function indicesOf(size: number): number[] {
    return Array.from({ length: size }, (_, i) => i);
}

// A phrasing of the set that is not among the last `windowOf(size)` of `recent` (the oldest first).
export function drawWording(size: number, recent: number[], random: () => number): number {
    if (size <= 1) {
        return 0;
    }
    const kept = new Set(recent.slice(-windowOf(size)));
    const open = indicesOf(size).filter((index) => !kept.has(index));
    const pool = open.length > 0 ? open : indicesOf(size);
    return pool[Math.min(Math.floor(random() * pool.length), pool.length - 1)];
}

export function rememberWording(recent: number[], index: number, size: number): number[] {
    return [...recent.filter((known) => known !== index), index].slice(-windowOf(size));
}

// What was said last, per reason, the oldest first. Kept across restarts.
export type WordingMemory = Partial<Record<VisitReason, number[]>>;

export function encodeWording(memory: WordingMemory): string {
    return JSON.stringify(memory);
}

export function decodeWording(text: string): WordingMemory {
    let saved: Record<string, unknown> = null;
    try {
        saved = JSON.parse(text);
    } catch {
        return {};
    }
    if (saved == null || typeof saved !== "object") {
        return {};
    }
    const memory: WordingMemory = {};
    for (const reason of VisitReasons) {
        const size = VisitPhrasings[reason];
        const list = Array.isArray(saved[reason]) ? (saved[reason] as unknown[]) : [];
        const valid = list.filter(
            (index): index is number => typeof index === "number" && Number.isInteger(index) && index >= 0 && index < size
        );
        if (valid.length > 0) {
            memory[reason] = valid.slice(-windowOf(size));
        }
    }
    return memory;
}
