// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Where Brokk's avatar stands and what opens beside it (FR-BOSS-009, AC1, AC14, #2002): the avatar sits in the sidebar's
// title row, or hangs from the window's top edge when the sidebar is not on screen; his hover tooltip stands under it
// (his floating group stands beside the sidebar: brokk-group-model.ts). Pure, so the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import type { BrokkSituation } from "./brokk-ask-model";

export type Rect = { left: number; top: number; width: number; height: number };

// In the title row, and hanging from the window's top edge (the pennant's old slot: the panels start 8 px below the edge
// and their controls 7 px lower still, so a 14 px avatar from the edge covers no control).
export const AvatarSizePx = 26;
export const HangingSizePx = 14;

export type AvatarVariant = "row" | "hanging";

// Never two Brokks on screen: the row of the sidebar when the sidebar is there, the window's edge when it is not.
export function avatarVariant(sidebarOnScreen: boolean): AvatarVariant {
    return sidebarOnScreen ? "row" : "hanging";
}

// Its distance from the window's right edge: off the corner on macOS, where nothing else sits there, and clear of the
// window controls the other platforms draw over the page at the top right.
export function hangingRightPx(controlsOnTheLeft: boolean): number {
    return controlsOnTheLeft ? 24 : 160;
}

// The pose his animated portrait takes at rest: awake, calm. It thinks while his own session works, never because other
// agents do: the ring and the pose say that he works, not that the forge does (AC2).
export function avatarSituation(ownWorking: boolean): BrokkSituation {
    return { working: ownWorking ? 1 : 0, waiting: 0, cardOpen: false, away: false };
}

// The hover tooltip is read only: it shows after the pointer rests on the avatar, and a pass over it shows nothing.
export const PeekDelayMs = 350;
export const PeekWidthPx = 296;
export const PeekGapPx = 8;
export const ViewMarginPx = 8;

export type Viewport = { width: number; height: number };

// Where the tooltip stands, in window coordinates: under the avatar, its right edge on the avatar's, kept inside the
// window.
export function peekPosition(
    anchor: Rect,
    viewport: Viewport,
    width: number = PeekWidthPx
): { top: number; left: number; width: number } {
    const fit = Math.max(0, Math.min(width, viewport.width - 2 * ViewMarginPx));
    const right = anchor.left + anchor.width;
    const left = Math.min(
        Math.max(right - fit, ViewMarginPx),
        Math.max(viewport.width - fit - ViewMarginPx, ViewMarginPx)
    );
    return { top: anchor.top + anchor.height + PeekGapPx, left, width: fit };
}
