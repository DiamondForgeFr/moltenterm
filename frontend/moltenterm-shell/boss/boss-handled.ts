// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The rows of À traiter the developer settled or ignored (FR-BOSS-009, AC16, #2026). A row that stands for a
// notification is settled by resolving the notification; the others (an agent that waits, a failing CI, a pull request
// ready) show a fact the app reads from elsewhere, so what the developer did with them is a mark of its own. A mark holds
// for the episode it was made on, the wait and state of the agent or the last update of the pull request: when the fact
// is new the row comes back. The marks are shared by the windows and views of this computer through the local storage,
// as what Brokk told is (brokk-visit-share.ts). Pure, so the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

export const HandledKey = "moltenterm:brokk-handled";

// A mark outlives its row by a month at most: the shared record must not grow for ever.
export const HandledKeepMs = 30 * 24 * 60 * 60 * 1000;

export type HandledRow = { key: string; since: number; tone: string };

export type HandledMark = { episode: string; at: number };

export type HandledRows = Record<string, HandledMark>;

export const EmptyHandled: HandledRows = {};

export function episodeOf(row: Pick<HandledRow, "since" | "tone">): string {
    return `${row.since}:${row.tone}`;
}

export function checkRowHandled(handled: HandledRows, row: HandledRow): boolean {
    const mark = handled?.[row.key];
    return mark != null && mark.episode === episodeOf(row);
}

function prune(handled: HandledRows, now: number): HandledRows {
    const kept: HandledRows = {};
    for (const [key, mark] of Object.entries(handled)) {
        if (now - mark.at < HandledKeepMs) {
            kept[key] = mark;
        }
    }
    return kept;
}

// What the storage holds, read defensively: anything odd is empty.
export function readHandled(raw: unknown, now: number): HandledRows {
    let value: any = raw;
    if (typeof raw === "string") {
        try {
            value = JSON.parse(raw);
        } catch {
            return EmptyHandled;
        }
    }
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return EmptyHandled;
    }
    const rows: HandledRows = {};
    for (const [key, mark] of Object.entries(value as Record<string, any>)) {
        if (typeof mark?.episode === "string" && typeof mark?.at === "number" && Number.isFinite(mark.at)) {
            rows[key] = { episode: mark.episode, at: mark.at };
        }
    }
    return prune(rows, now);
}

export function handledText(handled: HandledRows): string {
    return JSON.stringify(handled);
}

export function sameHandled(a: HandledRows, b: HandledRows): boolean {
    if (a === b) {
        return true;
    }
    const keys = Object.keys(a);
    return (
        keys.length === Object.keys(b).length &&
        keys.every((key) => b[key]?.episode === a[key].episode && b[key]?.at === a[key].at)
    );
}

// Two records in one: per row the later mark. The very same object when `b` adds nothing to `a`.
export function mergeHandled(a: HandledRows, b: HandledRows, now: number): HandledRows {
    const rows = { ...a };
    for (const [key, mark] of Object.entries(b)) {
        if (rows[key] == null || mark.at > rows[key].at) {
            rows[key] = mark;
        }
    }
    const next = prune(rows, now);
    return sameHandled(next, a) ? a : next;
}

export function markRowHandled(handled: HandledRows, row: HandledRow, now: number): HandledRows {
    return prune({ ...handled, [row.key]: { episode: episodeOf(row), at: now } }, now);
}
