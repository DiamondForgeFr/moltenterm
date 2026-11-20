// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The zones of a 360 × N (FR-SHELL-123 AC17 to AC20, #2433): the N visible places share the carpet's band by shares the
// developer sets, one list per number of zones. A border between two zones only trades width between its neighbours,
// so the zones always fill the band and their number never changes. Pure rules, kept apart from the layout so they
// are tested alone.

import { MinCarpetColumnPx } from "./carpet-model";

// A zone keeps this width at least: a drag stops there.
export const MinZonePx = MinCarpetColumnPx;
// Two shares closer than this (a hundredth of the band) are the same: the zones read as even.
const EvenTolerance = 0.01;
const ShareDigits = 10000;

// The shares of each configuration, by its number of zones ("2", "3"): each list sums to 1.
export type ZoneShares = Record<string, number[]>;

function keyOf(n: number): string {
    return String(n);
}

// The stored shares, keeping only the well-formed lists: the meta is written by older and newer versions alike.
export function readZoneShares(raw: unknown): ZoneShares {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        return {};
    }
    const rtn: ZoneShares = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const n = Number(key);
        if (!Number.isInteger(n) || n < 2 || n > 3 || !Array.isArray(value) || value.length !== n) {
            continue;
        }
        const shares = value.map((v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : NaN));
        if (shares.some((s) => Number.isNaN(s))) {
            continue;
        }
        const total = shares.reduce((acc, s) => acc + s, 0);
        rtn[keyOf(n)] = shares.map((s) => s / total);
    }
    return rtn;
}

// The shares of n zones, or null while they are equal (the default, nothing remembered).
export function zoneSharesOf(stored: ZoneShares, n: number): number[] {
    const shares = stored?.[keyOf(n)];
    return shares?.length === n ? shares : null;
}

export function withZoneShares(stored: ZoneShares, n: number, shares: number[]): ZoneShares {
    const rtn = { ...(stored ?? {}) };
    if (shares == null || zonesAreEven(shares, n)) {
        delete rtn[keyOf(n)];
        return rtn;
    }
    rtn[keyOf(n)] = roundShares(shares);
    return rtn;
}

export function roundShares(shares: number[]): number[] {
    const parts = shares.map((s) => Math.round(s * ShareDigits) / ShareDigits);
    const rest = 1 - parts.slice(0, -1).reduce((acc, s) => acc + s, 0);
    parts[parts.length - 1] = Math.round(rest * ShareDigits) / ShareDigits;
    return parts;
}

// Whether the zones read as equal: every share within a hundredth of the band of an equal part. No shares is even.
export function zonesAreEven(shares: number[], n: number): boolean {
    if (shares == null) {
        return true;
    }
    return shares.length === n && shares.every((s) => Math.abs(s - 1 / n) <= EvenTolerance);
}

// "Even out the zones" as the developer reads it: whole percents adding up to 100, the middle zone taking the leftover.
export function evenPercents(n: number): number[] {
    if (!(n >= 1)) {
        return [];
    }
    const side = Math.floor(100 / n);
    const percents = Array.from({ length: n }, () => side);
    percents[Math.floor(n / 2)] += 100 - side * n;
    return percents;
}

// The shares "Even out the zones" gives n zones (AC20): the whole percents of evenPercents. Two zones are exactly even,
// which is the default (no shares kept); three keep 33 / 34 / 33 so the widths are what the message says.
export function withEvenZones(stored: ZoneShares, n: number): ZoneShares {
    const percents = evenPercents(n);
    if (new Set(percents).size === 1) {
        return withZoneShares(stored, n, null);
    }
    return { ...(stored ?? {}), [keyOf(n)]: percents.map((p) => p / 100) };
}

function sum(values: number[]): number {
    return values.reduce((acc, v) => acc + v, 0);
}

// The widths of n zones sharing a band, in whole pixels adding up to the band (rounded down): equal parts without
// shares. A zone never falls under the minimum: the others share what it takes.
export function zoneWidthsPx(bandPx: number, n: number, shares: number[], minPx = MinZonePx): number[] {
    const total = Math.max(0, Math.floor(bandPx));
    const count = Math.max(1, n);
    const wanted = shares?.length === count ? shares : Array.from({ length: count }, () => 1 / count);
    let fixed = new Set<number>();
    let widths = wanted.map((s) => s * total);
    if (total >= count * minPx) {
        for (;;) {
            const low = widths.findIndex((w, i) => !fixed.has(i) && w < minPx);
            if (low < 0) {
                break;
            }
            fixed = new Set([...fixed, low]);
            const room = total - fixed.size * minPx;
            const freeShare = sum(wanted.filter((_, i) => !fixed.has(i)));
            widths = wanted.map((s, i) => (fixed.has(i) ? minPx : (s / freeShare) * room));
        }
    }
    const rtn: number[] = [];
    let edge = 0;
    let cumulative = 0;
    widths.forEach((w, i) => {
        cumulative += w;
        const next = i === widths.length - 1 ? total : Math.round(cumulative);
        rtn.push(next - edge);
        edge = next;
    });
    return rtn;
}

// The shares the widths stand for.
export function sharesOf(widths: number[]): number[] {
    const total = sum(widths);
    return total > 0 ? widths.map((w) => w / total) : widths.map(() => 1 / widths.length);
}

// The widths once the border on the right of zone `index` is dragged to `edgePx` (measured from the band's start):
// only the two zones on each side of it change, one gaining what the other loses, and neither goes under the minimum.
export function dragZoneBorder(widths: number[], index: number, edgePx: number, minPx = MinZonePx): number[] {
    if (index < 0 || index >= widths.length - 1) {
        return widths;
    }
    const start = sum(widths.slice(0, index));
    const pair = widths[index] + widths[index + 1];
    const low = Math.min(minPx, pair / 2);
    const left = Math.round(
        Math.min(Math.max(Number.isFinite(edgePx) ? edgePx - start : widths[index], low), pair - low)
    );
    const rtn = widths.slice();
    rtn[index] = left;
    rtn[index + 1] = pair - left;
    return rtn;
}

// The width of each carpet column when the carpet rests with its first visible column at `page`: the zones' widths on
// the columns in view, the first zone's width on the columns stored before them and the widest zone's on those after,
// so the carpet always reaches the next whole place however the zones share the band. Those widths are for the moving
// carpet only: a column coming into view takes the width of the zone it lands in once the carpet rests.
export function zoneColumnWidthsPx(zoneWidths: number[], page: number, columns: number): number[] {
    const n = zoneWidths.length;
    const widest = Math.max(...zoneWidths);
    return Array.from({ length: columns }, (_, j) => {
        const place = j - page;
        if (place < 0) {
            return zoneWidths[0];
        }
        return place < n ? zoneWidths[place] : widest;
    });
}

export type ZoneFocus = { kind: "fixed" } | { kind: "column"; index: number };

export type ZoneInsert = {
    // Where the new column goes among the carpet's columns, counted before it is in.
    index: number;
    // The first column in view once it is in, counted after it is in.
    start: number;
};

// Where a panel added under a 360 × N goes (FR-SHELL-123 AC17) and what the zones show afterwards, for a carpet of
// `count` columns whose first visible one is `page`, showing `n` zones. The panel lands next to the focused one, on
// its right unless it is the last in view (or `side` says before); the focused panel keeps its zone, the zones keep
// their number, and the end beyond the new panel leaves the view. With the focus in the fixed zone the new panel takes
// the first zone. × 1 shows the new panel alone.
export function planZoneInsert(
    count: number,
    page: number,
    n: number,
    focus: ZoneFocus,
    side: "before" | "after" = null
): ZoneInsert {
    const zones = Math.max(1, n);
    const last = Math.max(0, count + 1 - zones);
    const start = (index: number) => Math.min(Math.max(0, index), last);
    const first = Math.min(Math.max(0, page), Math.max(0, count - zones));
    if (focus == null || focus.kind === "fixed") {
        return { index: first, start: start(first) };
    }
    const f = Math.min(Math.max(0, focus.index), Math.max(0, count - 1));
    const k = f - first;
    const inView = k >= 0 && k < zones;
    const lastZone = inView && k === zones - 1;
    const after = side == null ? !(lastZone && zones > 1) : side === "after";
    const index = after ? f + 1 : f;
    if (zones === 1 || !inView) {
        return { index, start: start(index) };
    }
    return { index, start: start(k < zones - 1 ? first : first + 1) };
}
