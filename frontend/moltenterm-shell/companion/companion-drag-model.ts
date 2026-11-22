// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a drag of a block of the companion needs (FR-SHELL-018, #2459), apart from the window so that it is tested without
// one: the long press that picks a block up, the place a dragged block would take in the list, and the drop zone of the
// main agent's block. Loaded with the arranging mode, out of the startup bundle.

import { FlowBlock, flowLayout } from "./companion-flow-model";

// A press on a block's icon that stays this long, nearly where it began, enters the arranging mode and picks the block up.
export const LongPressMs = 500;
// A pointer that moves farther than this while it presses is scrolling or dragging something else, not pressing.
export const LongPressSlopPx = 8;
// A press on a block's header in the arranging mode is a drag once the pointer moved this far, a click before.
export const DragStartPx = 4;
// The drop zone of the main agent's block takes a drop this near its edge, so that a drop beside it still counts.
export const ZoneSlackPx = 12;

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; width: number; height: number };

// The timers a press uses, so that a test drives them.
export type PressTimers = {
    set: (run: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
};

const WindowTimers: PressTimers = {
    set: (run, ms) => setTimeout(run, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type LongPressState = "pressing" | "fired" | "released" | "cancelled";

export type LongPress = {
    // The pointer moved: it leaves the press when it went past the slop.
    move: (x: number, y: number) => void;
    // The pointer was released, before the delay or after it.
    release: () => void;
    // Something else took the pointer (a scroll, a lost capture, the pointer cancelled).
    cancel: () => void;
    state: () => LongPressState;
};

export type LongPressOptions = {
    x: number;
    y: number;
    // Called once, with where the pointer is by then, when the press has lasted.
    onFire: (at: Point) => void;
    delayMs?: number;
    slopPx?: number;
    timers?: PressTimers;
};

export function startLongPress(options: LongPressOptions): LongPress {
    const timers = options.timers ?? WindowTimers;
    const slop = options.slopPx ?? LongPressSlopPx;
    let state: LongPressState = "pressing";
    let at: Point = { x: options.x, y: options.y };
    const handle = timers.set(() => {
        if (state !== "pressing") {
            return;
        }
        state = "fired";
        options.onFire(at);
    }, options.delayMs ?? LongPressMs);
    const stop = (next: LongPressState) => {
        if (state !== "pressing") {
            return;
        }
        state = next;
        timers.clear(handle);
    };
    return {
        move: (x, y) => {
            at = { x, y };
            if (state === "pressing" && Math.hypot(x - options.x, y - options.y) > slop) {
                stop("cancelled");
            }
        },
        release: () => stop("released"),
        cancel: () => stop("cancelled"),
        state: () => state,
    };
}

// Whether a pointer going down may start a press or a drag: the primary button of a mouse, the one contact of a pen or
// a finger. A right or middle click, and a second finger, never do.
export function startsPress(e: { button: number; isPrimary: boolean; pointerType: string }): boolean {
    if (!e.isPrimary) {
        return false;
    }
    return e.pointerType !== "mouse" || e.button === 0;
}

export function passedDragStart(from: Point, to: Point): boolean {
    return Math.hypot(to.x - from.x, to.y - from.y) >= DragStartPx;
}

// Where a dragged block's top left corner goes: under the pointer, as far from the corner as it was when picked up.
export function dragCorner(pointer: Point, grab: Point): Point {
    return { x: pointer.x - grab.x, y: pointer.y - grab.y };
}

export function pointInBox(point: Point, box: Box, slack = 0): boolean {
    return (
        point.x >= box.x - slack &&
        point.x <= box.x + box.width + slack &&
        point.y >= box.y - slack &&
        point.y <= box.y + box.height + slack
    );
}

// The index the dragged block would have in the list if it were dropped with its center at `center` (the flow's own
// coordinates): of every place the list offers it, the one whose slot, laid out by the flow itself, is nearest. Only the
// blocks' heights and the pointer decide, never where the dragged block stands now, so a block moves aside once and
// stays put while the pointer stays, whatever the columns. A tie keeps the current index.
export function dropIndexAt(blocks: FlowBlock[], draggedId: string, companionWidth: number, center: Point): number {
    const from = blocks.findIndex((b) => b.id === draggedId);
    if (from < 0) {
        return from;
    }
    const dragged = blocks[from];
    const others = blocks.filter((b) => b.id !== draggedId);
    let best = from;
    let bestDistance = Infinity;
    for (let i = 0; i <= others.length; i++) {
        const order = [...others.slice(0, i), dragged, ...others.slice(i)];
        const slot = flowLayout(order, companionWidth).items[i];
        const distance = Math.hypot(
            center.x - (slot.x + slot.width / 2),
            center.y - (slot.y + Math.max(0, dragged.height) / 2)
        );
        if (distance < bestDistance - 0.5 || (i === from && distance <= bestDistance + 0.5)) {
            best = i;
            bestDistance = Math.min(distance, bestDistance);
        }
    }
    return best;
}
