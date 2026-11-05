// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The comm screen the bubble opens into (FR-BOSS-001, AC12): when it shows, and the area that keeps it open. Pure, so
// the rules are tested without a window (boss-screen.tsx draws the screen).
//
// Why the open state is data and not a CSS :hover on the shape that grows: a pointer on the edge of the round would
// flip :hover as the shape grows under it and shrinks away from it, and the screen would shake. Only the round at rest
// can open it; once open, a zone of the screen's final size (never animated) holds it, and the round lies inside that
// zone, so the pointer that opened it can only leave by leaving the zone.
//
// The zone reaches a few pixels past the screen on every side. Without that margin the zone's outer edges are the
// round's own edges (the screen grows from the corner it sits in), and a hand that jitters across that edge would
// close the screen and open it again at every pixel: found by hand on the round's right and bottom edge in the bottom
// right corner. With it, the edge of the round lies well inside the zone, and closing takes a clear step out of it.
// A margin in space, so that the screen still closes at once and not after a delay.

import { BubbleSizePx, Corner, Rect } from "./boss-place";
import { BrokkSituation, restingPose } from "./brokk-ask-model";

// The screen's side and the zone's margin past it. Must match --mt-boss-screen and --mt-boss-slop in boss-bubble.css.
export const ScreenSizePx = 200;
export const ScreenSlopPx = 8;

// What holds the screen open: the pointer on the round or on the open zone, the keyboard focus (focus-visible), and
// whether Escape hid it, until the pointer or the focus comes back.
export type ScreenHold = { pointer: boolean; focus: boolean; dismissed: boolean };

export const NoScreenHold: ScreenHold = { pointer: false, focus: false, dismissed: false };

export type ScreenEvent = "pointer-enter" | "pointer-leave" | "focus" | "blur" | "dismiss" | "reset";

// The hold after an event: the very same object when nothing changes, so that no one draws again for it.
export function holdAfter(hold: ScreenHold, event: ScreenEvent): ScreenHold {
    switch (event) {
        case "pointer-enter":
            return hold.pointer && !hold.dismissed ? hold : { ...hold, pointer: true, dismissed: false };
        case "pointer-leave":
            return hold.pointer ? { ...hold, pointer: false } : hold;
        case "focus":
            return hold.focus && !hold.dismissed ? hold : { ...hold, focus: true, dismissed: false };
        case "blur":
            return hold.focus ? { ...hold, focus: false } : hold;
        case "dismiss":
            return hold.dismissed ? hold : { ...hold, dismissed: true };
        default:
            return hold === NoScreenHold ? hold : NoScreenHold;
    }
}

export type ScreenContext = {
    // The bubble is being dragged: it stays a round of 44 px, which the drag's maths measures.
    dragging: boolean;
    // His card shows: the screen stays open beside it, like a video call beside what he shows (FR-BOSS-007, AC8, #1958).
    cardOpen: boolean;
};

// Open while the pointer or the focus holds it, or while his card shows, without a hover; once the card hides, the hold
// alone decides, so the screen stays open if the pointer is on it. A drag folds it back to the round.
export function screenShows(hold: ScreenHold, context: ScreenContext): boolean {
    if (context.dragging) {
        return false;
    }
    if (context.cardOpen) {
        return true;
    }
    if (hold.dismissed) {
        return false;
    }
    return hold.pointer || hold.focus;
}

// The caption's status line says what his face shows (FR-BOSS-007, AC9, #1958), as keys: a first line, and a second one
// when there is more to tell. `worker` is the name of the one agent at work, when exactly one works.
export type CaptionLine = { key: string; count?: number; vars?: Record<string, string> };
export type ScreenCaption = { status: CaptionLine; detail?: CaptionLine };

function workingLine(working: number, worker: string): CaptionLine {
    if (working === 1 && worker) {
        return { key: "boss.screen.working", vars: { name: worker } };
    }
    return { key: "boss.screen.workingCount", count: working };
}

export function screenCaption(situation: BrokkSituation, worker: string): ScreenCaption {
    const pose = restingPose(situation);
    if (pose === "rest") {
        return { status: { key: "boss.screen.asleep" } };
    }
    if (situation.waiting > 0) {
        const status = { key: "boss.screen.toHandle", count: situation.waiting };
        return situation.working > 0 ? { status, detail: workingLine(situation.working, worker) } : { status };
    }
    if (pose === "thinking") {
        return { status: workingLine(situation.working, worker), detail: { key: "boss.screen.nothingForYou" } };
    }
    return { status: { key: "boss.screen.quiet" } };
}

export type Point = { x: number; y: number };

// The zone the open screen takes, in the round's own coordinates (the round's top left is 0, 0): the screen grows
// toward the inside of the window, so it keeps the round's two edges on the corner's side. The zone is the screen and
// its margin; a margin of 0 is the screen itself.
export function screenZone(
    corner: Corner,
    round: number = BubbleSizePx,
    screen: number = ScreenSizePx,
    slop: number = ScreenSlopPx
): Rect {
    return {
        left: (corner[1] === "l" ? 0 : round - screen) - slop,
        top: (corner[0] === "t" ? 0 : round - screen) - slop,
        width: screen + 2 * slop,
        height: screen + 2 * slop,
    };
}

export function overRound(point: Point, round: number = BubbleSizePx): boolean {
    const radius = round / 2;
    return Math.hypot(point.x - radius, point.y - radius) <= radius;
}

export function overZone(point: Point, corner: Corner, slop: number = ScreenSlopPx): boolean {
    const zone = screenZone(corner, BubbleSizePx, ScreenSizePx, slop);
    return (
        point.x >= zone.left &&
        point.x <= zone.left + zone.width &&
        point.y >= zone.top &&
        point.y <= zone.top + zone.height
    );
}

// What the browser's hit test finds under a pointer that stands still: the round while the screen is closed, the whole
// zone once it is open (the zone takes the pointer only then).
export function pointerOver(point: Point, corner: Corner, open: boolean, slop: number = ScreenSlopPx): boolean {
    return open ? overZone(point, corner, slop) : overRound(point);
}
