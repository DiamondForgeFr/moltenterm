// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "360 × N" (FR-SHELL-123, DS-SHELL-134): the fixed zone plus N visible places on the carpet, the other panels stored
// on it, hidden but alive. The rules of the places, kept apart from the layout so they are tested alone: which numbers
// are offered, the equal parts, where the carpet starts and the whole-panel steps of its scroll.

import {
    CarpetColumnGapPx,
    CarpetMarginPx,
    CarpetPadXPx,
    CarpetLayout,
    clampFixedPx,
    clampScroll,
    FixedColumnGapPx,
    PinnedColumnMinPx,
    ReadableCarpetColumnPx,
} from "./carpet-model";

// 1, 2 or 3 places: beyond 3 a place falls under a comfortable width even on the widest screens.
export const PlaceChoices = [1, 2, 3] as const;
export const MaxPlaces = 3;
// Below this a scroll step is noise (a trackpad resting), above it the carpet moves one whole panel. One gesture steps
// once (../wheel-gesture.ts, #1466).
export const WheelStepPx = 24;
const EdgeEpsilonPx = 0.5;

export type PlaceRefusal = "nothing" | "narrow";

export type PlaceOption = {
    n: number;
    offered: boolean;
    reason?: PlaceRefusal;
    // How many carpet panels it stores, and the width each place gets.
    stored: number;
    slotPx: number;
};

// A stored count: 1, 2 or 3; anything else is none.
export function readPlaces(raw: unknown): number {
    return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= MaxPlaces ? raw : null;
}

// What the carpet's chrome takes beside the fixed zone: its margins and its padding.
function carpetChromePx(): number {
    return 2 * CarpetMarginPx + 2 * CarpetPadXPx;
}

// The width each of n places gets on a carpet whose band is viewportPx wide: the whole band (FR-SHELL-125-AC7).
export function placeWidthPx(viewportPx: number, n: number): number {
    if (!(viewportPx > 0) || !(n >= 1)) {
        return 0;
    }
    return Math.max(0, (viewportPx - (n - 1) * CarpetColumnGapPx) / n);
}

// The width each of n places gets once the fixed zone (first column and the columns pinned beside it) takes zonePx.
export function placesSlotPx(widthPx: number, zonePx: number, n: number): number {
    if (!(widthPx > 0)) {
        return 0;
    }
    return placeWidthPx(Math.max(0, widthPx - zonePx - carpetChromePx()), n);
}

// The fixed zone's extra width from the columns pinned beside the first one, each with its gap.
export function besideZonePx(pinnedPx: number[]): number {
    return (pinnedPx ?? []).reduce((acc, px) => acc + Math.max(PinnedColumnMinPx, px > 0 ? px : 0) + FixedColumnGapPx, 0);
}

// The equal parts (AC5): the first column and every visible place share the width alike, the columns pinned beside
// keeping theirs. The fixed zone then keeps its bounds: 520 px and the terminal floor at least, half of the window at
// most unless that floor needs more (clampFixedPx); the places share what it leaves.
export function placesFixedPx(widthPx: number, n: number, floorPx = 0, besidePx = 0): number {
    if (!(widthPx > 0)) {
        return 0;
    }
    const count = Math.max(1, n);
    const room = widthPx - carpetChromePx() - (count - 1) * CarpetColumnGapPx;
    const share = (room - Math.max(0, besidePx)) / (count + 1);
    return clampFixedPx(share, widthPx, floorPx);
}

// The width of each place for n places, the fixed zone at its equal part.
export function placesShareSlotPx(widthPx: number, n: number, floorPx = 0, besidePx = 0): number {
    return placesSlotPx(widthPx, placesFixedPx(widthPx, n, floorPx, besidePx) + Math.max(0, besidePx), n);
}

export function placesFit(widthPx: number, n: number, floorPx = 0, besidePx = 0): boolean {
    return placesShareSlotPx(widthPx, n, floorPx, besidePx) + EdgeEpsilonPx >= ReadableCarpetColumnPx;
}

// The numbers the chooser shows (AC3), computed each time it opens: offered when it stores at least one carpet
// column (C > N) and each place keeps its readable width; otherwise greyed with its reason.
export function placeOptions(carpetColumns: number, widthPx: number, floorPx = 0, besidePx = 0): PlaceOption[] {
    return PlaceChoices.map((n) => {
        const slotPx = placesShareSlotPx(widthPx, n, floorPx, besidePx);
        const stored = Math.max(0, carpetColumns - n);
        if (carpetColumns <= n) {
            return { n, offered: false, reason: "nothing", stored, slotPx };
        }
        if (!placesFit(widthPx, n, floorPx, besidePx)) {
            return { n, offered: false, reason: "narrow", stored, slotPx };
        }
        return { n, offered: true, stored, slotPx };
    });
}

// The places shown (AC7): the view's N while it fits, otherwise the largest number that does, at least one. N itself
// is kept: the view returns to it once the window widens again.
export function effectivePlaces(n: number, widthPx: number, floorPx = 0, besidePx = 0): number {
    for (let k = Math.min(MaxPlaces, Math.max(1, n)); k > 1; k--) {
        if (placesFit(widthPx, k, floorPx, besidePx)) {
            return k;
        }
    }
    return 1;
}

// The first visible place's carpet column (AC6): the panel the button belongs to, unless fewer than n columns follow
// it, then its left neighbours fill the places.
export function placesStartIndex(panelIndex: number, carpetCount: number, n: number): number {
    if (!(carpetCount > 0) || panelIndex < 0) {
        return 0;
    }
    const last = Math.max(0, carpetCount - Math.max(1, n));
    return Math.min(Math.max(0, panelIndex), last);
}

// The scroll that shows a carpet column in the first place: the carpet's start for its first column, that column's
// start edge otherwise, within the carpet's last position.
export function placeScrollPx(layout: CarpetLayout, index: number): number {
    if (layout == null || index <= 0 || index >= layout.columns.length) {
        return 0;
    }
    return clampScroll(layout, layout.columns[index].x);
}

// The next rest position of the carpet in a direction: the first stop past the current position, or the end it
// already reached.
export function nextScrollStop(stops: number[], current: number, dir: number): number {
    if (!stops?.length) {
        return current;
    }
    if (dir > 0) {
        return stops.find((s) => s > current + EdgeEpsilonPx) ?? stops[stops.length - 1];
    }
    for (let i = stops.length - 1; i >= 0; i--) {
        if (stops[i] < current - EdgeEpsilonPx) {
            return stops[i];
        }
    }
    return stops[0];
}

// The nearest rest position, for a carpet left between two panels (a window resized, a drag ended).
export function nearestScrollStop(stops: number[], current: number): number {
    if (!stops?.length) {
        return current;
    }
    return stops.reduce((best, s) => (Math.abs(s - current) < Math.abs(best - current) ? s : best));
}
