// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Swiping between workspaces (FR-SHELL-082, DS-SHELL-130, #1248): the sidebar follows a horizontal two-finger gesture
// 1:1, settles on the neighbour or springs back on release, and past either end resists like a rubber band while a
// ring fills. The rules are kept apart from the DOM so they can be tested without a trackpad.
//
// Chromium's wheel events carry no phase (Electron's scroll-touch-begin/end were removed in Electron 23, and on macOS
// the momentum stays in the finger's scroll sequence), so the machine reads the phases from the deltas themselves:
// - a fresh touch: a pause between events (momentum is continuous), a reversal (momentum never reverses), or deltas
//   that break the momentum's smooth decay;
// - a release: no event for ReleaseGapMs, or the momentum's signature (deltas decaying smoothly after the fingers).
// After a release the momentum is absorbed: it never moves anything.

// Positions are in finger pixels along the bottom bar: positive goes toward the next workspace (two fingers moving
// left, deltaX > 0), negative toward the previous one.

// A release past this share of the width settles on the neighbour.
export const CommitFraction = 0.35;
// A release this fast toward the neighbour (px/ms) settles on it from a shorter distance...
export const CommitVelocity = 0.5;
// ...as long as it travelled this share of the width.
export const FlickFraction = 0.06;
// Fingers coming back this fast (px/ms) when they lift cancel, however far the page went.
export const ReverseVelocity = 0.15;
// No wheel event for this long: the fingers lifted without momentum.
export const ReleaseGapMs = 90;
// A wheel event after a pause this long is a fresh touch: momentum events come every frame.
export const FreshTouchGapMs = 60;
// The momentum's signature: this many deltas in a row, none larger than the one before nor much smaller, and the
// last at most MomentumMaxRatio of the first.
export const MomentumRun = 4;
export const MomentumMinRatio = 0.6;
export const MomentumMaxRatio = 0.9;
// The finger travel past either end that fills the ring.
export const PullFullPx = 160;
// The rubber band's reach, as a share of the width: the displacement tends to it however far the fingers go.
export const RubberFraction = 0.35;
// The settle: a critically damped spring of this stiffness, cut at SettleMs (under 0.3 % of its start left).
export const SpringOmega = 30;
export const SettleMs = 280;
// The velocity window: the deltas of the last this many ms.
const VelocityWindowMs = 40;
const MaxSamples = 8;

// What waits on a side: a whole page that comes in with the fingers (a workspace, the page left), a pull that opens
// something once its ring is full (the library, the new-workspace page), or nothing.
export type SideKind = "page" | "pull" | "none";
export type SwipeSides = { prev: SideKind; next: SideKind };
export type SwipeCtx = { width: number; sides: SwipeSides };

export type SwipeSample = { dx: number; at: number };

export type SwipeSettle = {
    from: number;
    to: number;
    // px/ms, along the same axis as the positions.
    v0: number;
    at: number;
    // The side it settles on (0: back to rest).
    commit: -1 | 0 | 1;
    kind: SideKind;
};

export type SwipeAbsorb = { sign: number; lastAbs: number; lastAt: number };

export type SwipeState = {
    phase: "idle" | "tracking" | "settling";
    // The finger travel since the page's rest, while tracking.
    raw: number;
    lastAt: number;
    samples: SwipeSample[];
    settle: SwipeSettle;
    // The momentum being absorbed, after a release.
    absorb: SwipeAbsorb;
};

export type SwipeEvent = { dx: number; dy: number; at: number };

export type SwipeResult = {
    state: SwipeState;
    // The event belongs to the swipe: the caller cancels its default.
    handled: boolean;
    // Set on the event that released the fingers: the settle that starts.
    released?: SwipeSettle;
    // A fresh touch took the sidebar (from rest or during a settle).
    grabbed?: boolean;
};

export function initialSwipeState(): SwipeState {
    return { phase: "idle", raw: 0, lastAt: 0, samples: [], settle: null, absorb: null };
}

// The state of a view that appears after a switch made by a swipe: the gesture's momentum may follow it here.
export function arrivedSwipeState(absorb: SwipeAbsorb): SwipeState {
    return { ...initialSwipeState(), absorb };
}

function sideKind(ctx: SwipeCtx, side: number): SideKind {
    if (side === 0) {
        return "none";
    }
    return side > 0 ? ctx.sides.next : ctx.sides.prev;
}

function rubberReach(width: number): number {
    return Math.max(1, width * RubberFraction);
}

// Resistance grows with distance: the displacement tends to the reach however far the fingers go.
export function rubberBand(travel: number, reach: number): number {
    const d = Math.abs(travel);
    const shown = reach * (1 - 1 / (1 + d / reach));
    return Math.sign(travel) * shown;
}

function unRubber(shown: number, reach: number): number {
    const s = Math.min(Math.abs(shown), reach * 0.999);
    const d = reach * (1 / (1 - s / reach) - 1);
    return Math.sign(shown) * d;
}

// Where the page stands for a finger travel: 1:1 toward a page (up to a whole width), a rubber band elsewhere.
export function trackOffset(raw: number, ctx: SwipeCtx): number {
    const kind = sideKind(ctx, Math.sign(raw));
    if (kind === "page") {
        return Math.max(-ctx.width, Math.min(ctx.width, raw));
    }
    return rubberBand(raw, rubberReach(ctx.width));
}

// The finger travel that puts the page where it stands: a fresh touch takes the sidebar there.
export function rawForOffset(offset: number, ctx: SwipeCtx): number {
    const kind = sideKind(ctx, Math.sign(offset));
    if (kind === "page") {
        return offset;
    }
    return unRubber(offset, rubberReach(ctx.width));
}

// How full the ring is: only toward a pull, 1 once the fingers travelled PullFullPx past the end.
export function pullProgress(raw: number, ctx: SwipeCtx): number {
    if (sideKind(ctx, Math.sign(raw)) !== "pull") {
        return 0;
    }
    return Math.min(1, Math.abs(raw) / PullFullPx);
}

// A critically damped spring's distance left to its target after t ms, from x0 left with velocity v0 (px/ms). The
// velocity is bounded so the spring neither crosses its target nor runs far away from it first.
export function springAt(x0: number, v0: number, t: number): number {
    const w = SpringOmega / 1000;
    const v = Math.max(-w * Math.abs(x0), Math.min(0.5 * w * Math.abs(x0), v0 * Math.sign(x0))) * Math.sign(x0);
    return (x0 + (v + w * x0) * t) * Math.exp(-w * t);
}

// Where a settle stands at a time: it ends exactly on its target at SettleMs.
export function settleOffset(settle: SwipeSettle, now: number): number {
    const t = Math.max(0, now - settle.at);
    if (t >= SettleMs) {
        return settle.to;
    }
    // v0 moves the position; the spring follows the distance left (to - position), whose velocity is -v0.
    return settle.to - springAt(settle.to - settle.from, -settle.v0, t);
}

export function settleDone(settle: SwipeSettle, now: number): boolean {
    return now - settle.at >= SettleMs;
}

// The settle's positions sampled every step ms from a time on, for a Web Animation (the compositor plays it).
export function settleFrames(settle: SwipeSettle, fromTime: number, step = 1000 / 60): number[] {
    const frames: number[] = [];
    for (let t = Math.max(settle.at, fromTime); t < settle.at + SettleMs; t += step) {
        frames.push(settleOffset(settle, t));
    }
    frames.push(settle.to);
    return frames;
}

// Where the page stands now, in any phase.
export function swipeOffset(state: SwipeState, now: number, ctx: SwipeCtx): number {
    if (state.phase === "tracking") {
        return trackOffset(state.raw, ctx);
    }
    if (state.phase === "settling" && state.settle != null) {
        return settleOffset(state.settle, now);
    }
    return 0;
}

// The fingers' speed over the last few events, px/ms.
export function swipeVelocity(samples: readonly SwipeSample[]): number {
    if (samples.length < 2) {
        return 0;
    }
    const last = samples[samples.length - 1];
    const recent = samples.filter((s) => last.at - s.at <= VelocityWindowMs);
    if (recent.length < 2) {
        return 0;
    }
    const span = Math.max(8, last.at - recent[0].at);
    // The first sample's delta happened before the window opened.
    const travel = recent.slice(1).reduce((sum, s) => sum + s.dx, 0);
    return travel / span;
}

// The momentum's signature at the end of the samples: deltas of one sign, each smaller than the one before by a
// smooth ratio.
export function looksLikeMomentum(samples: readonly SwipeSample[]): boolean {
    if (samples.length < MomentumRun) {
        return false;
    }
    const run = samples.slice(-MomentumRun);
    const sign = Math.sign(run[0].dx);
    if (sign === 0 || Math.abs(run[0].dx) < 4) {
        return false;
    }
    for (let i = 1; i < run.length; i++) {
        if (Math.sign(run[i].dx) !== sign) {
            return false;
        }
        // Rounded deltas may repeat a value; they never grow.
        const ratio = Math.abs(run[i].dx) / Math.abs(run[i - 1].dx);
        if (ratio < MomentumMinRatio || ratio > 1) {
            return false;
        }
    }
    return Math.abs(run[run.length - 1].dx) / Math.abs(run[0].dx) <= MomentumMaxRatio;
}

// Whether an event continues the momentum being absorbed: same way, no pause, and no break in its decay.
export function continuesMomentum(absorb: SwipeAbsorb, ev: SwipeEvent): boolean {
    if (absorb == null || ev.at - absorb.lastAt > FreshTouchGapMs) {
        return false;
    }
    if (ev.dx === 0) {
        return true;
    }
    if (Math.sign(ev.dx) !== absorb.sign) {
        return false;
    }
    const abs = Math.abs(ev.dx);
    return abs <= absorb.lastAbs * 1.15 + 1 && abs >= absorb.lastAbs * 0.5 - 1;
}

// The decision on release: the side it settles on and where.
export function releaseSettle(raw: number, velocity: number, at: number, ctx: SwipeCtx): SwipeSettle {
    const from = trackOffset(raw, ctx);
    const side = Math.sign(raw) as -1 | 0 | 1;
    const kind = sideKind(ctx, side);
    let commit: -1 | 0 | 1 = 0;
    if (kind === "page") {
        const along = velocity * side;
        const far = Math.abs(from) >= CommitFraction * ctx.width;
        const flick = along >= CommitVelocity && Math.abs(from) >= FlickFraction * ctx.width;
        const reversing = along <= -ReverseVelocity;
        if ((far || flick) && !reversing) {
            commit = side;
        }
    } else if (kind === "pull" && pullProgress(raw, ctx) >= 1 && velocity * side > -CommitVelocity) {
        commit = side;
    }
    // A committed pull opens its page, which slides in by itself: the rubber band returns to rest.
    const to = commit !== 0 && kind === "page" ? commit * ctx.width : 0;
    return { from, to, v0: velocity, at, commit, kind };
}

function releaseNow(state: SwipeState, at: number, ctx: SwipeCtx): { state: SwipeState; settle: SwipeSettle } {
    const last = state.samples[state.samples.length - 1];
    const settle = releaseSettle(state.raw, swipeVelocity(state.samples), at, ctx);
    const absorb: SwipeAbsorb =
        last != null && last.dx !== 0
            ? { sign: Math.sign(last.dx), lastAbs: Math.abs(last.dx), lastAt: last.at }
            : null;
    return {
        state: { phase: "settling", raw: 0, lastAt: state.lastAt, samples: [], settle, absorb },
        settle,
    };
}

// The clock moved without an event: a tracking gesture whose events stopped is released.
export function swipeTick(state: SwipeState, now: number, ctx: SwipeCtx): SwipeResult {
    if (state.phase === "tracking" && now - state.lastAt >= ReleaseGapMs) {
        const r = releaseNow(state, state.lastAt + ReleaseGapMs, ctx);
        return { state: r.state, handled: false, released: r.settle };
    }
    if (state.phase === "settling" && state.settle != null && settleDone(state.settle, now)) {
        return { state: { ...state, phase: "idle", settle: null }, handled: false };
    }
    return { state, handled: false };
}

// One wheel event.
export function swipeWheel(state: SwipeState, ev: SwipeEvent, ctx: SwipeCtx): SwipeResult {
    let s = state;
    let released: SwipeSettle;
    if (s.phase === "tracking" && ev.at - s.lastAt >= ReleaseGapMs) {
        const r = releaseNow(s, s.lastAt + ReleaseGapMs, ctx);
        s = r.state;
        released = r.settle;
    }
    if (s.phase === "settling" && s.settle != null && settleDone(s.settle, ev.at)) {
        s = { ...s, phase: "idle", settle: null };
    }
    if (s.phase === "tracking") {
        const raw = s.raw + ev.dx;
        const samples = [...s.samples, { dx: ev.dx, at: ev.at }].slice(-MaxSamples);
        const tracked: SwipeState = { ...s, raw, lastAt: ev.at, samples };
        if (looksLikeMomentum(samples)) {
            const r = releaseNow(tracked, ev.at, ctx);
            return { state: r.state, handled: true, released: r.settle };
        }
        return { state: tracked, handled: true, released };
    }
    if (continuesMomentum(s.absorb, ev)) {
        return {
            state: {
                ...s,
                absorb: { sign: s.absorb.sign, lastAbs: Math.abs(ev.dx) || s.absorb.lastAbs, lastAt: ev.at },
            },
            handled: true,
            released,
        };
    }
    // A fresh touch: only a horizontal one starts a swipe.
    if (Math.abs(ev.dx) <= Math.abs(ev.dy)) {
        return { state: { ...s, absorb: null }, handled: false, released };
    }
    const offset = swipeOffset(s, ev.at, ctx);
    const raw = rawForOffset(offset, ctx) + ev.dx;
    return {
        state: {
            phase: "tracking",
            raw,
            lastAt: ev.at,
            samples: [{ dx: ev.dx, at: ev.at }],
            settle: null,
            absorb: null,
        },
        handled: true,
        released,
        grabbed: true,
    };
}

// What the screen shows for a position: the page's shift, the tint's share, the shadow and the ring. Under reduced
// motion nothing slides and no tint fades; the ring still fills.
export type SwipeLook = {
    pageX: number;
    // The neighbour's page on its side, or null when none comes in.
    neighbour: { side: -1 | 1; x: number } | null;
    tint: number;
    shadow: number;
    ring: { side: -1 | 1; progress: number; ready: boolean } | null;
};

export function swipeLook(offset: number, raw: number, ctx: SwipeCtx, reduced: boolean): SwipeLook {
    const side = Math.sign(offset) as -1 | 0 | 1;
    const kind = sideKind(ctx, side);
    const progress = pullProgress(raw, ctx);
    const ring = kind === "pull" && side !== 0 ? { side, progress, ready: progress >= 1 } : null;
    if (reduced) {
        return { pageX: 0, neighbour: null, tint: 0, shadow: 0, ring };
    }
    const width = Math.max(1, ctx.width);
    if (kind === "page" && side !== 0) {
        return {
            pageX: -offset,
            neighbour: { side, x: side * width - offset },
            tint: Math.min(1, Math.abs(offset) / width),
            shadow: 0,
            ring: null,
        };
    }
    return {
        pageX: -offset,
        neighbour: null,
        tint: 0,
        shadow: side === 0 ? 0 : Math.min(1, Math.abs(offset) / rubberReach(width)),
        ring,
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

// The sides of the sidebar's workspace page: a workspace on each side, the library before the first, the
// new-workspace page after the last.
export function workspaceSides(index: number, count: number): SwipeSides {
    return {
        prev: index > 0 ? "page" : "pull",
        next: index >= 0 && index < count - 1 ? "page" : "pull",
    };
}

// The new-workspace page goes back to the workspace on its left; the library goes back to the right.
export const CreatePageSides: SwipeSides = { prev: "page", next: "none" };
export const LibrarySides: SwipeSides = { prev: "none", next: "page" };

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
