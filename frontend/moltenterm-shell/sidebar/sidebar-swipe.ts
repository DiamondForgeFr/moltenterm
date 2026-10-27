// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Swiping between workspaces on the sidebar (FR-SHELL-082): a horizontal wheel gesture moves one workspace, and past
// either end it becomes a pull that opens the library (left) or the new-workspace page (right) once it is long enough.
// The rules are kept apart from the component so they can be tested without a trackpad.

// How far a gesture travels before it moves one workspace.
export const SwipeStepPx = 70;
// How far a pull past either end travels before it opens what waits there.
export const PullPx = 170;
// A pause this long in the wheel events starts a new gesture's count.
export const SwipeIdleMs = 260;
// A pause this long ends a gesture's momentum: a locked swipe listens again.
export const GestureGapMs = 200;
// A pull left unfinished this long springs back.
export const PullSpringMs = 240;
// The first wheel event this soon after a switch belongs to the gesture that made it (it may reach the tab view of the
// new workspace, which did not see it start).
export const SwitchMomentumMs = 1000;

export type SwipeState = {
    acc: number;
    lastAt: number;
    // Set once a gesture switched or opened something: the rest of it (its momentum) does nothing.
    locked: boolean;
};

export type SwipeAction =
    | { kind: "none" }
    | { kind: "switch"; direction: -1 | 1 }
    | { kind: "pull"; side: -1 | 1; amount: number }
    | { kind: "pulled"; side: -1 | 1 };

export type SwipeResult = { state: SwipeState; action: SwipeAction; handled: boolean };

export function initialSwipeState(): SwipeState {
    return { acc: 0, lastAt: 0, locked: false };
}

// One wheel event. index: the current workspace's place among count; switchedAt: when the last switch made by a swipe,
// a dot or a key was asked (0 if none is known).
export function swipeStep(
    state: SwipeState,
    ev: { dx: number; dy: number; at: number },
    pos: { index: number; count: number },
    switchedAt = 0
): SwipeResult {
    if (Math.abs(ev.dx) <= Math.abs(ev.dy)) {
        return { state, action: { kind: "none" }, handled: false };
    }
    const gap = state.lastAt === 0 ? Infinity : ev.at - state.lastAt;
    let locked = state.locked && gap < GestureGapMs;
    if (!locked && state.lastAt < switchedAt && ev.at - switchedAt < SwitchMomentumMs) {
        locked = true;
    }
    if (locked) {
        return { state: { acc: 0, lastAt: ev.at, locked: true }, action: { kind: "none" }, handled: true };
    }
    const acc = (gap > SwipeIdleMs ? 0 : state.acc) + ev.dx;
    const last = pos.count - 1;
    const edge: -1 | 1 | 0 = acc < 0 && pos.index <= 0 ? -1 : acc > 0 && pos.index >= last ? 1 : 0;
    if (edge !== 0) {
        const amount = Math.abs(acc) / PullPx;
        if (amount >= 1) {
            return {
                state: { acc: 0, lastAt: ev.at, locked: true },
                action: { kind: "pulled", side: edge },
                handled: true,
            };
        }
        return {
            state: { acc, lastAt: ev.at, locked: false },
            action: { kind: "pull", side: edge, amount },
            handled: true,
        };
    }
    if (Math.abs(acc) > SwipeStepPx) {
        const direction = acc > 0 ? 1 : -1;
        return { state: { acc: 0, lastAt: ev.at, locked: true }, action: { kind: "switch", direction }, handled: true };
    }
    return { state: { acc, lastAt: ev.at, locked: false }, action: { kind: "none" }, handled: true };
}

// Where the pull indicator and the sidebar content stand for a pull of amount (1 = long enough): the indicator grows in
// from its side and swells a little once the pull is long enough, the content follows the finger by up to 30 px.
export function pullLook(
    side: -1 | 1,
    amount: number
): { opacity: number; scale: number; shiftX: number; contentX: number; ready: boolean } {
    const a = Math.max(0, Math.min(1, amount));
    return {
        opacity: Math.min(1, a * 1.5),
        scale: amount >= 1 ? 1.12 : 0.4 + 0.6 * a,
        shiftX: side * (1 - a) * 16,
        contentX: -side * a * 30,
        ready: amount >= 1,
    };
}

// The workspace a switch by direction lands on, or null past either end.
export function stepTarget(ids: readonly string[], currentId: string, direction: -1 | 1): string {
    const at = ids.indexOf(currentId);
    if (at < 0) {
        return null;
    }
    return ids[at + direction] ?? null;
}

// Past seven workspaces the dots shrink and the row scrolls (DS: the prototype's ".dots.many").
export const ManyDotsThreshold = 7;

export function manyDots(count: number): boolean {
    return count > ManyDotsThreshold;
}

// The scroll that puts the current dot in the middle of the row, within the row's scroll range.
export function centredScroll(dotLeft: number, dotWidth: number, rowWidth: number, scrollWidth: number): number {
    const want = dotLeft - rowWidth / 2 + dotWidth / 2;
    return Math.max(0, Math.min(Math.max(0, scrollWidth - rowWidth), Math.round(want)));
}

// ⌥1…⌥9 (macOS) jump to the workspace at that place in the bottom bar.
export function workspaceAtNumber(ids: readonly string[], n: number): string {
    if (!Number.isInteger(n) || n < 1 || n > 9) {
        return null;
    }
    return ids[n - 1] ?? null;
}
