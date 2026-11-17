// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// When a reading is no longer current (FR-BOSS-009, AC95 and AC96, #2341): older than its window, and than 7 days at
// most. Pure, and kept apart from the grid's model, which the companion also loads up front: only the code that decides
// what Brokk's grid shows and what calls him reads it, and that loads on demand (NFR-PERF-003, bundle.initialJsMB).

import type { UsageWindow } from "../companion/companion-gauges-model";
import { mainWindow, windowLength } from "./usage-week-model";

// What counts as a reading that is no longer current, and as the developer's recent use of a provider: 7 days.
export const UseWindowMs = 7 * 24 * 60 * 60 * 1000;

// A reading is current for as long as its window lasts, and for 7 days at most.
export function staleAfterMs(windowMins: number): number {
    return windowMins > 0 ? Math.min(windowMins * 60 * 1000, UseWindowMs) : UseWindowMs;
}

export function isStale(readAt: number, windowMins: number, now: number): boolean {
    return readAt > 0 && now - readAt > staleAfterMs(windowMins);
}

// A reading older than its main window (or than 7 days) is no news: the one that tells a plan usage above 90 % ignores
// it. A reading with no running window, or none at all, is not called stale: it has nothing to draw.
export function readingStale(snapshot: { windows?: UsageWindow[]; readat?: number }, now: number): boolean {
    const main = mainWindow(snapshot?.windows, now);
    return main != null && isStale(snapshot.readat ?? 0, windowLength(main), now);
}
