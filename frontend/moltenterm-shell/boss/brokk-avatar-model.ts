// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Where Brokk's avatar stands and what opens beside it (FR-BOSS-009, AC1, AC14, AC27, #2002, #2070): the avatar sits in
// the sidebar's title row, which stays at the window's edge when the sidebar is collapsed, or hangs from the window's
// top edge when there is no sidebar; hovering it opens his floating group, which stands beside the sidebar
// (brokk-group-model.ts). Pure, so the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import type { BrokkPose, BrokkSituation } from "./brokk-ask-model";
import type { SidebarPlace } from "./brokk-edge-model";

export type Rect = { left: number; top: number; width: number; height: number };

// In the title row, and hanging from the window's top edge (the pennant's old slot: the panels start 8 px below the edge
// and their controls 7 px lower still, so a 14 px avatar from the edge covers no control).
export const AvatarSizePx = 26;
export const HangingSizePx = 14;

export type AvatarVariant = "row" | "edge" | "hanging";

// Never two Brokks on screen: the row of the sidebar when the sidebar is there, the strip that stays of it when it is
// collapsed (#2070), the window's top edge when there is no sidebar.
export function avatarVariant(place: SidebarPlace): AvatarVariant {
    if (place === "screen") {
        return "row";
    }
    return place === "edge" ? "edge" : "hanging";
}

// The rings around the face (AC2, AC34, #2083) are drawn in a 30-unit box that the avatar's size scales: the working ring
// is an arc at radius 13 with a 2-unit stroke, its box 4 px (row) or 2 px (edge, hanging) outside the face. The strip's
// face is 20 px (sidebar.css, --mt-edge-face).
export const RingUnits = 30;
export const RingStrokeUnits = 2;
export const EdgeFacePx = 20;

// The working ring's box in px: its inset from the face (CSS: brokk-avatar.css) is 4 px in the row, 2 px elsewhere.
export function workingRingBoxPx(variant: AvatarVariant): number {
    if (variant === "row") {
        return AvatarSizePx + 8;
    }
    if (variant === "edge") {
        return EdgeFacePx + 4;
    }
    return HangingSizePx + 4;
}

// The download ring is concentric with the working ring, outside it, with the same stroke: its centre-line lies 2 px
// beyond the working ring's outer edge, so the two never sit on each other, whatever the variant (#2083, AC34).
export function downloadRingRadiusUnits(variant: AvatarVariant): number {
    const pxPerUnit = workingRingBoxPx(variant) / RingUnits;
    return RingUnits / 2 + 2 / pxPerUnit;
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

// The mark the avatar wears while his group is open (FR-BOSS-009, AC17, #2219): the first letter of his name, so that no
// still of his face stands next to the one animated Brokk. An empty name gives the default name's initial.
export function brokkInitial(name: string): string {
    const first = Array.from((name ?? "").trim())[0] ?? "B";
    return first.toLocaleUpperCase();
}

// The only poses that situation gives: he never speaks (nothing waits) nor sleeps (never away) there. The portrait is
// declared with the transitions between these two only, so that the sidebar's 26 px face mounts fewer 480 px videos.
export const AvatarPoses: readonly BrokkPose[] = ["listening", "thinking"];

// Hovering the face opens his group (FR-BOSS-009, AC52 to AC55, #2103): there is no hover card. The pointer must rest on
// the face, so that a pass on the way to the window buttons opens nothing; a group opened that way closes by itself
// once the pointer has left both the face and the group, and stays once the developer interacts with it (pinned).
export const FaceHoverOpenMs = 250;
export const FaceHoverCloseMs = 400;

export type FaceClick = "open" | "pin" | "close";

// A click (or Enter, Space) on the face: it opens a closed group, pins one the hover opened, and closes only a pinned
// one. The hover's group must never close under the click that meant to keep it.
export function faceClickAction(open: boolean, pinned: boolean): FaceClick {
    if (!open) {
        return "open";
    }
    return pinned ? "close" : "pin";
}

export type FaceHoverDeps = {
    isOpen: () => boolean;
    isPinned: () => boolean;
    // No menu and no dialog is open.
    canOpen: () => boolean;
    // Opens the group unpinned, without the focus.
    open: () => void;
    close: () => void;
    setTimer: (run: () => void, ms: number) => unknown;
    clearTimer: (timer: unknown) => void;
};

// The face and the group tell it where the pointer is; the clock is the deps', so the tests drive it by hand.
export class FaceHoverIntent {
    deps: FaceHoverDeps;
    onFace = false;
    onGroup = false;
    openTimer: unknown = null;
    closeTimer: unknown = null;

    constructor(deps: FaceHoverDeps) {
        this.deps = deps;
    }

    clearOpen(): void {
        if (this.openTimer != null) {
            this.deps.clearTimer(this.openTimer);
        }
        this.openTimer = null;
    }

    clearClose(): void {
        if (this.closeTimer != null) {
            this.deps.clearTimer(this.closeTimer);
        }
        this.closeTimer = null;
    }

    // `pressed`: a button is held as the pointer arrives (a drag, a text selection): nothing opens.
    enterFace(pressed: boolean): void {
        this.onFace = true;
        this.clearClose();
        if (pressed || this.openTimer != null || this.deps.isOpen()) {
            return;
        }
        this.openTimer = this.deps.setTimer(() => this.opens(), FaceHoverOpenMs);
    }

    leaveFace(): void {
        this.onFace = false;
        this.clearOpen();
        this.closeSoon();
    }

    enterGroup(): void {
        this.onGroup = true;
        this.clearClose();
    }

    leaveGroup(): void {
        this.onGroup = false;
        this.closeSoon();
    }

    // The face was clicked: the click decides, nothing waits to open or to close.
    cancel(): void {
        this.clearOpen();
        this.clearClose();
    }

    // The group left the page: the pointer can no longer be over it.
    groupGone(): void {
        this.onGroup = false;
        this.clearClose();
    }

    closeSoon(): void {
        if (this.onFace || this.onGroup || this.closeTimer != null || !this.deps.isOpen() || this.deps.isPinned()) {
            return;
        }
        this.closeTimer = this.deps.setTimer(() => this.closes(), FaceHoverCloseMs);
    }

    opens(): void {
        this.openTimer = null;
        if (!this.onFace || this.deps.isOpen() || !this.deps.canOpen()) {
            return;
        }
        this.deps.open();
    }

    closes(): void {
        this.closeTimer = null;
        if (this.onFace || this.onGroup || !this.deps.isOpen() || this.deps.isPinned()) {
            return;
        }
        this.deps.close();
    }
}
