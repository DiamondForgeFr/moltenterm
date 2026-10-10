// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The top tab bar's geometry (FR-SHELL-056, DS-SHELL-098). Wave gives every tab one width; MoltenTerm sizes each tab
// to its content between 64 and 200 px and draws the pinned Project tab as a 32 px icon. A short name's tab hugs it
// (DS-SHELL-098's 96 px floor left holes after "~" or "e2e"). When the strip is too short, the widest tabs give way
// first, down to 96 px, so short names never get cut before long ones and no name is cut below a readable width;
// only then does the strip scroll. Kept apart from tabbar.tsx so the maths can be tested without the app.

export const TabMinWidth = 64;
export const TabShrinkMinWidth = 96;
export const TabMaxWidth = 200;
export const PinnedTabWidth = 32;

export type TabLayoutItem = { natural: number; pinned?: boolean };
export type TabLayout = { widths: number[]; offsets: number[]; total: number; scrollable: boolean };

export function clampTabWidth(natural: number): number {
    const width = Number.isFinite(natural) ? Math.ceil(natural) : TabMinWidth;
    return Math.min(TabMaxWidth, Math.max(TabMinWidth, width));
}

export function tabOffsets(widths: number[]): number[] {
    const offsets: number[] = [];
    let left = 0;
    for (const width of widths) {
        offsets.push(left);
        left += width;
    }
    return offsets;
}

// The largest cap at which the capped widths fit in `space`, never below the shrink floor (tabs already narrower
// than the cap keep their width).
function fittingCap(widths: number[], space: number): number {
    const sorted = [...widths].sort((a, b) => a - b);
    let rest = space;
    for (let i = 0; i < sorted.length; i++) {
        const remaining = sorted.length - i;
        const cap = Math.floor(rest / remaining);
        if (cap < sorted[i]) {
            return Math.max(TabShrinkMinWidth, cap);
        }
        rest -= sorted[i];
    }
    return TabMaxWidth;
}

export function layoutTabs(items: TabLayoutItem[], space: number): TabLayout {
    const pinnedWidth = items.filter((item) => item.pinned).length * PinnedTabWidth;
    const wanted = items.filter((item) => !item.pinned).map((item) => clampTabWidth(item.natural));
    const wantedTotal = wanted.reduce((sum, w) => sum + w, 0);
    const room = Math.max(0, (space ?? 0) - pinnedWidth);
    const cap = wantedTotal > room ? fittingCap(wanted, room) : TabMaxWidth;
    const widths = items.map((item) => (item.pinned ? PinnedTabWidth : Math.min(clampTabWidth(item.natural), cap)));
    const offsets = tabOffsets(widths);
    const total = widths.reduce((sum, w) => sum + w, 0);
    return { widths, offsets, total, scrollable: total > (space ?? 0) };
}

// Where a dragged tab lands, whatever the widths: moving right, it passes a neighbour once its right edge crosses the
// neighbour's centre; moving left, once its left edge does (a centre rule would keep a wide tab from reaching the
// start of the strip). Both come down to one test on the strip without the dragged tab: a neighbour goes before it
// when its centre there lies left of the dragged tab's left edge. `widths` follows the current order, the dragged
// tab included at `dragIndex`. Pinned tabs stay first: nothing lands before the first `pinnedCount` tabs.
export function tabDropIndex(widths: number[], dragIndex: number, left: number, pinnedCount = 0): number {
    const others = widths.filter((_, i) => i !== dragIndex);
    const offsets = tabOffsets(others);
    let index = 0;
    for (let i = 0; i < others.length; i++) {
        if (offsets[i] + others[i] / 2 < left) {
            index = i + 1;
        }
    }
    return Math.min(others.length, Math.max(pinnedCount, index));
}

export function moveTabId(ids: string[], from: number, to: number): string[] {
    if (from === to || from < 0 || from >= ids.length) {
        return ids;
    }
    const next = [...ids];
    const [id] = next.splice(from, 1);
    next.splice(Math.min(Math.max(0, to), next.length), 0, id);
    return next;
}
