// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Where the bubble is and when it steps aside (FR-BOSS-001, DS-BOSS-001): its place is an offset from the nearest corner
// of the window's content, so a resize keeps it in view; the window's meta keeps the place and a manual collapse. The
// collapse while typing is decided here from two rectangles. Pure, so the rules are tested without a window.

import { BossBubbleMetaKey } from "./boss-name";

export const BubbleSizePx = 44;
// The nearest the bubble gets to the content's edges: the frame's default margin.
export const BubbleMarginPx = 8;
// Where a bubble nobody moved sits: off the corner by this much, inside the frame margin.
export const BubbleDefaultInsetPx = 16;
// Between the bubble and its peek.
export const PeekGapPx = 8;

// The pennant hangs from the window's top edge (boss-bubble.css): its height sets where the peek starts under it.
export const PennantHeightPx = 14;
// Its distance from the window's right edge: off the corner on macOS, where nothing else sits there, and clear of the
// window controls the other platforms draw over the page at the top right.
export function pennantRightPx(controlsOnTheLeft: boolean): number {
    return controlsOnTheLeft ? 24 : 160;
}

export type Corner = "tl" | "tr" | "bl" | "br";
export const Corners: Corner[] = ["tl", "tr", "bl", "br"];

export type BubblePlace = { corner: Corner; dx: number; dy: number };
export type BubbleState = { place: BubblePlace; collapsed: boolean };

export type Rect = { left: number; top: number; width: number; height: number };
export type Area = { width: number; height: number };

export const DefaultPlace: BubblePlace = { corner: "br", dx: BubbleDefaultInsetPx, dy: BubbleDefaultInsetPx };
export const DefaultBubbleState: BubbleState = { place: DefaultPlace, collapsed: false };

const MaxOffsetPx = 20000;

function offset(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.round(Math.min(MaxOffsetPx, Math.max(0, value)));
}

// What the window's meta holds, read defensively: anything odd is the default.
export function readBubbleState(meta: Record<string, any>): BubbleState {
    const raw = meta?.[BossBubbleMetaKey];
    if (raw == null || typeof raw !== "object") {
        return DefaultBubbleState;
    }
    const corner = Corners.includes(raw.corner) ? (raw.corner as Corner) : DefaultPlace.corner;
    return {
        place: { corner, dx: offset(raw.dx, DefaultPlace.dx), dy: offset(raw.dy, DefaultPlace.dy) },
        collapsed: raw.collapsed === true,
    };
}

export function bubbleMetaValue(state: BubbleState): Record<string, any> {
    return { corner: state.place.corner, dx: state.place.dx, dy: state.place.dy, collapsed: state.collapsed };
}

export function sameBubbleState(a: BubbleState, b: BubbleState): boolean {
    return (
        a.collapsed === b.collapsed &&
        a.place.corner === b.place.corner &&
        a.place.dx === b.place.dx &&
        a.place.dy === b.place.dy
    );
}

// Keeps a rectangle inside the area, a margin from its edges (an area too small for it pins it to the top left margin).
export function clampRect(rect: Rect, area: Area, margin: number = BubbleMarginPx): Rect {
    const maxLeft = Math.max(margin, area.width - rect.width - margin);
    const maxTop = Math.max(margin, area.height - rect.height - margin);
    return {
        ...rect,
        left: Math.min(maxLeft, Math.max(margin, rect.left)),
        top: Math.min(maxTop, Math.max(margin, rect.top)),
    };
}

// The place of a rectangle dragged to where it is: the area's corner nearest its centre, and its distance from that
// corner's two edges.
export function rectToPlace(rect: Rect, area: Area): BubblePlace {
    const left = rect.left + rect.width / 2 < area.width / 2;
    const top = rect.top + rect.height / 2 < area.height / 2;
    return {
        corner: `${top ? "t" : "b"}${left ? "l" : "r"}` as Corner,
        dx: offset(left ? rect.left : area.width - rect.left - rect.width, 0),
        dy: offset(top ? rect.top : area.height - rect.top - rect.height, 0),
    };
}

// Where a place lands in an area of this size (what the CSS of placeStyle draws).
export function placeToRect(place: BubblePlace, area: Area, size: number = BubbleSizePx): Rect {
    const left = place.corner[1] === "l" ? place.dx : area.width - size - place.dx;
    const top = place.corner[0] === "t" ? place.dy : area.height - size - place.dy;
    return clampRect({ left, top, width: size, height: size }, area);
}

export type PlaceStyle = Partial<Record<"top" | "bottom" | "left" | "right", string>>;

// The place as CSS anchored to its corner: the browser keeps it in view on a resize with no measuring, the offset never
// leaving the margin nor the area (the percentage is the container's width or height).
export function placeStyle(
    place: BubblePlace,
    size: number = BubbleSizePx,
    margin: number = BubbleMarginPx
): PlaceStyle {
    const along = (value: number) => `max(${margin}px, min(${value}px, calc(100% - ${size + margin}px)))`;
    return {
        [place.corner[0] === "t" ? "top" : "bottom"]: along(place.dy),
        [place.corner[1] === "l" ? "left" : "right"]: along(place.dx),
    };
}

// The peek beside the bubble: on the side of the corner it sits in, past the bubble's own size and a gap, aligned with
// the bubble's edge. The clearance is the room more the open comm screen takes (FR-BOSS-001, AC12): the peek lies
// beyond the screen, not under it.
export function peekStyle(
    place: BubblePlace,
    size: number = BubbleSizePx,
    margin: number = BubbleMarginPx,
    clearance: number = 0
): PlaceStyle {
    const gap = size + PeekGapPx + clearance;
    const vertical = place.corner[0] === "t" ? "top" : "bottom";
    const clamped = placeStyle(place, size, margin);
    return {
        [vertical]: `calc(${clamped[vertical]} + ${gap}px)`,
        [place.corner[1] === "l" ? "left" : "right"]: clamped[place.corner[1] === "l" ? "left" : "right"],
    };
}

export type CardStyle = PlaceStyle & { maxHeight: string };

// The Sessions card (FR-BOSS-002) where the peek sits, beside the bubble, with the height the window leaves it between
// the bubble and the far edge: a long list scrolls inside the card, which never grows past the window. The clearance is
// the room more the comm screen takes, open beside the card (FR-BOSS-007, AC8): the card lies beyond it.
export function cardStyle(
    place: BubblePlace,
    size: number = BubbleSizePx,
    margin: number = BubbleMarginPx,
    clearance: number = 0
): CardStyle {
    const vertical = place.corner[0] === "t" ? "top" : "bottom";
    const anchored = peekStyle(place, size, margin, clearance);
    return { ...anchored, maxHeight: `calc(100% - ${anchored[vertical]} - ${margin}px)` };
}

// The card under the pennant, aligned with its right edge.
export function pennantCardStyle(right: number, margin: number = BubbleMarginPx): CardStyle {
    const top = PennantHeightPx + PeekGapPx;
    return { top: `${top}px`, right: `${right}px`, maxHeight: `calc(100% - ${top + margin}px)` };
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
    return (
        a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height
    );
}

const ModifierKeys = new Set([
    "Shift",
    "Control",
    "Alt",
    "Meta",
    "AltGraph",
    "CapsLock",
    "Fn",
    "FnLock",
    "OS",
    "Hyper",
]);

export type KeyLike = { key: string; metaKey?: boolean; repeat?: boolean };

// A keystroke typed into a terminal: not a modifier pressed alone, and not an application shortcut (Command, on the
// platforms that have it), which the terminal never receives.
export function isTypingKey(event: KeyLike): boolean {
    return !!event.key && !ModifierKeys.has(event.key) && event.metaKey !== true;
}

export type TypingInput = {
    // Settings > Collapse while I type under it.
    enabled: boolean;
    // The developer collapsed it: it stays so until brought back, and typing changes nothing.
    manual: boolean;
    key: KeyLike;
    bubble: Rect;
    // The area of the terminal the keystroke reaches; null when it reaches none.
    terminal: Rect;
};

// The bubble steps aside when a keystroke reaches a terminal whose area lies under it (AC4).
export function collapsesWhileTyping(input: TypingInput): boolean {
    if (!input.enabled || input.manual || input.bubble == null || input.terminal == null) {
        return false;
    }
    return isTypingKey(input.key) && rectsOverlap(input.bubble, input.terminal);
}

// "Once the count rises": last is the count seen at the previous check, null before the first reading is in; the cue
// plays on a rise only, never for the reading that first arrives.
export function nextCue(last: number | null, count: number, ready: boolean): { last: number | null; cue: boolean } {
    if (!ready) {
        return { last: null, cue: false };
    }
    return { last: count, cue: last != null && count > last };
}
