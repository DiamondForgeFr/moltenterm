// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { CreateColours, freshColour, makeCreateDraft, pendingLetter, typeSuggestions } from "./sidebar-create-model";
import { workspaceNumberBindings } from "./sidebar-keys";
import {
    arrivedSwipeState,
    centredScroll,
    CreatePageSides,
    FreshTouchGapMs,
    heldRaw,
    initialSwipeState,
    LibrarySides,
    looksLikeMomentum,
    manyDots,
    momentumOnly,
    PullDrainMs,
    PullHoldMs,
    pullProgress,
    PullTravelPx,
    rawForOffset,
    ReleaseGapMs,
    ringFill,
    rubberBand,
    RubberMaxPx,
    settleFrames,
    SettleMs,
    settleOffset,
    stepTarget,
    StrokeGapMs,
    SwipeCtx,
    swipeLook,
    swipeOffset,
    SwipeResult,
    SwipeSettle,
    SwipeState,
    swipeTick,
    swipeTouch,
    swipeWheel,
    trackOffset,
    workspaceAtNumber,
    workspaceSides,
} from "./sidebar-swipe";
import { arrivalOffset, isArrival, parseSwitchIntent, switchDirection, SwitchIntentMaxAgeMs } from "./sidebar-switch";

const Width = 240;
// The middle of three workspaces: a page on each side.
const Middle: SwipeCtx = { width: Width, sides: workspaceSides(1, 3) };
const Last: SwipeCtx = { width: Width, sides: workspaceSides(2, 3) };
const First: SwipeCtx = { width: Width, sides: workspaceSides(0, 3) };

type Run = { state: SwipeState; at: number; results: SwipeResult[] };

// Feeds wheel deltas every `every` ms (120 Hz by default) from `start`.
function feed(dxs: number[], ctx: SwipeCtx, opts: { start?: number; state?: SwipeState; every?: number } = {}): Run {
    let state = opts.state ?? initialSwipeState();
    let at = opts.start ?? 1000;
    const every = opts.every ?? 8;
    const results: SwipeResult[] = [];
    for (const dx of dxs) {
        const r = swipeWheel(state, { dx, dy: 0, at }, ctx);
        state = r.state;
        results.push(r);
        at += every;
    }
    return { state, at: at - every, results };
}

// The fingers lift: no more events (StrokeGapMs releases whatever the release does).
function lift(run: Run, ctx: SwipeCtx): { state: SwipeState; settle: SwipeSettle } {
    const r = swipeTick(run.state, run.at + StrokeGapMs, ctx);
    return { state: r.state, settle: r.released ?? run.results.find((x) => x.released)?.released };
}

// A macOS momentum tail after the fingers: each delta a little smaller than the one before.
function momentum(from: number, count: number): number[] {
    const out: number[] = [];
    let v = from;
    for (let i = 0; i < count; i++) {
        v *= 0.93;
        out.push(Math.max(1, Math.round(v)));
    }
    return out;
}

const released = (run: Run) => run.results.filter((r) => r.released).map((r) => r.released);

// Fingers that speed up from rest, then hold their pace: the deltas a real swipe starts with.
function fingers(total: number, pace = 12): number[] {
    const out = [2, 5, 8].map((v) => Math.sign(total) * Math.min(v, pace));
    let left = Math.abs(total) - out.reduce((sum, v) => sum + Math.abs(v), 0);
    while (left > 0) {
        const step = Math.min(pace, left);
        out.push(Math.sign(total) * step);
        left -= step;
    }
    return out;
}

// The fingers lift, with a touch phase source.
function touchLift(run: Run, ctx: SwipeCtx): SwipeSettle {
    return swipeTouch(run.state, "end", run.at + 4, ctx).released;
}

// How full the ring shows at a time, in any phase (the view reads the same).
function ringOf(state: SwipeState, at: number, ctx: SwipeCtx): number {
    const offset = swipeOffset(state, at, ctx);
    const raw = state.phase === "tracking" ? heldRaw(state, at, ctx) : rawForOffset(offset, ctx);
    return swipeLook(offset, raw, ctx, false).ring?.progress ?? 0;
}

describe("workspace swipe: tracking (FR-SHELL-082, #1248, TC-SHELL-200)", () => {
    it("follows the fingers 1:1, both ways, without lifting", () => {
        const run = feed([10, 10, 10, 10, -5, -5], Middle);
        expect(run.state.phase).toBe("tracking");
        expect(swipeOffset(run.state, run.at, Middle)).toBe(30);
        const back = feed([-20, -20, -20], Middle, { state: run.state, start: run.at + 8 });
        expect(swipeOffset(back.state, back.at, Middle)).toBe(-30);
    });

    it("never goes further than a whole width toward a workspace", () => {
        const run = feed(Array(40).fill(12), Middle);
        expect(swipeOffset(run.state, run.at, Middle)).toBe(Width);
    });

    it("leaves vertical scrolling alone", () => {
        const r = swipeWheel(initialSwipeState(), { dx: 5, dy: 40, at: 10 }, Middle);
        expect(r.handled).toBe(false);
        expect(r.state.phase).toBe("idle");
    });

    it("draws the neighbour's page beside it and cross-fades the tint with the drag", () => {
        const look = swipeLook(60, 60, Middle, false);
        expect(look.pageX).toBe(-60);
        expect(look.neighbour).toEqual({ side: 1, x: Width - 60 });
        expect(look.tint).toBeCloseTo(0.25);
        expect(swipeLook(-Width, -Width, Middle, false).neighbour).toEqual({ side: -1, x: 0 });
    });
});

describe("workspace swipe: release (TC-SHELL-201)", () => {
    it("commits past 35 % of the width", () => {
        const run = feed(Array(10).fill(9), Middle, { every: 30 });
        const { settle } = lift(run, Middle);
        expect(settle).toMatchObject({ commit: 1, to: Width, kind: "page" });
    });

    it("springs back from a short slow drag", () => {
        const run = feed(Array(5).fill(4), Middle, { every: 30 });
        const { settle } = lift(run, Middle);
        expect(settle).toMatchObject({ commit: 0, to: 0 });
    });

    it("commits a short fast flick by its velocity", () => {
        const run = feed([6, 10, 12], Middle);
        expect(swipeOffset(run.state, run.at, Middle)).toBeLessThan(0.35 * Width);
        const { settle } = lift(run, Middle);
        expect(settle).toMatchObject({ commit: 1, to: Width });
    });

    it("cancels when the fingers reverse before release", () => {
        const run = feed([...Array(12).fill(12), -12, -14, -16], Middle);
        expect(swipeOffset(run.state, run.at, Middle)).toBeGreaterThan(0.35 * Width);
        const { settle } = lift(run, Middle);
        expect(settle).toMatchObject({ commit: 0, to: 0 });
    });

    it("takes the momentum's smooth decay as the fingers lifting, and settles at once", () => {
        const run = feed([...Array(12).fill(10), ...momentum(10, 8)], Middle);
        const r = released(run);
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ commit: 1, to: Width });
        expect(run.state.phase).toBe("settling");
        expect(looksLikeMomentum([10, 9, 8, 7].map((dx, i) => ({ dx, at: i * 8 })))).toBe(true);
        expect(looksLikeMomentum([10, 12, 8, 11].map((dx, i) => ({ dx, at: i * 8 })))).toBe(false);
    });

    it("settles with a critically damped spring, within 300 ms, on its target", () => {
        const settle: SwipeSettle = { from: 100, to: Width, v0: 0.4, at: 0, commit: 1, kind: "page" };
        let previous = settle.from;
        for (let t = 0; t <= SettleMs; t += 4) {
            const x = settleOffset(settle, t);
            expect(x).toBeGreaterThanOrEqual(previous - 1e-9);
            expect(x).toBeLessThanOrEqual(Width);
            previous = x;
        }
        expect(SettleMs).toBeLessThan(300);
        expect(settleOffset(settle, SettleMs)).toBe(Width);
        expect(Width - settleOffset(settle, SettleMs - 1)).toBeLessThan(1);
        const frames = settleFrames(settle, 0);
        expect(frames[frames.length - 1]).toBe(Width);
    });
});

describe("workspace swipe: no lost gestures (TC-SHELL-202)", () => {
    it("absorbs the momentum after a commit: it never switches twice", () => {
        const run = feed([...Array(12).fill(14), ...momentum(14, 60)], Middle);
        expect(released(run).filter((s) => s.commit !== 0)).toHaveLength(1);
        expect(run.results.filter((r) => r.grabbed)).toHaveLength(1);
        expect(run.results.every((r) => r.handled)).toBe(true);
    });

    it("takes a new gesture during the momentum at once: a reversal", () => {
        const first = feed([...Array(12).fill(14), ...momentum(14, 6)], Middle);
        const back = feed([-3, -6, -9], Middle, { state: first.state, start: first.at + 8 });
        expect(back.results[0].grabbed).toBe(true);
        expect(back.state.phase).toBe("tracking");
    });

    it("takes a new gesture during the momentum at once: deltas that jump up again", () => {
        const first = feed([...Array(12).fill(14), ...momentum(14, 20)], Middle);
        const again = feed([12, 16], Middle, { state: first.state, start: first.at + 8 });
        expect(again.results[0].grabbed).toBe(true);
    });

    it("takes a new gesture after a pause, however short the lock used to be", () => {
        const first = feed([...Array(12).fill(14), ...momentum(14, 4)], Middle);
        const again = feed([2, 3, 5], Middle, { state: first.state, start: first.at + FreshTouchGapMs + 1 });
        expect(again.results[0].grabbed).toBe(true);
    });

    it("grabs the sidebar where the settle stands", () => {
        const run = feed(Array(5).fill(4), Middle, { every: 30 });
        const { state, settle } = lift(run, Middle);
        const at = settle.at + 60;
        const standing = settleOffset(settle, at);
        const grab = swipeWheel(state, { dx: 5, dy: 0, at: at + FreshTouchGapMs + 1 }, Middle);
        expect(grab.grabbed).toBe(true);
        expect(swipeOffset(grab.state, at, Middle)).toBeCloseTo(settleOffset(settle, at + FreshTouchGapMs + 1) + 5, 0);
        expect(standing).toBeLessThan(20);
    });

    it("in the view a switch reached, ignores the gesture's momentum and takes the next touch", () => {
        const arrived = arrivedSwipeState({ sign: 1, lastAbs: 12, lastAt: 1000 });
        const tail = feed(momentum(12, 30), Middle, { state: arrived, start: 1008 });
        expect(tail.results.every((r) => r.handled && !r.grabbed)).toBe(true);
        expect(tail.state.phase).toBe("idle");
        const fresh = feed([-4, -8], Middle, { state: tail.state, start: tail.at + 8 });
        expect(fresh.results[0].grabbed).toBe(true);
    });
});

describe("workspace swipe: past either end (TC-SHELL-203, TC-SHELL-204)", () => {
    it("resists more the further it is pulled, never past its reach", () => {
        expect(rubberBand(0)).toBe(0);
        const a = rubberBand(50);
        const b = rubberBand(100);
        const c = rubberBand(400);
        expect(a).toBeLessThan(50);
        expect(b - a).toBeLessThan(a);
        expect(c).toBeLessThan(RubberMaxPx);
        expect(rubberBand(-50)).toBe(-a);
        expect(trackOffset(100, Last)).toBeCloseTo(b);
    });

    it("fills the ring with the fingers' travel past the last workspace, and opens the new-workspace page when full", () => {
        expect(pullProgress(PullTravelPx / 2, Middle)).toBe(0);
        const look = swipeLook(trackOffset(PullTravelPx, Last), PullTravelPx, Last, false);
        expect(look.ring).toEqual({ side: 1, progress: 1, ready: true });
        expect(look.shadow).toBeGreaterThan(0);
        expect(look.neighbour).toBeNull();
        const run = feed(Array(40).fill(12), Last, { every: 30 });
        expect(released(run)).toHaveLength(1);
        expect(released(run)[0]).toMatchObject({ commit: 1, kind: "pull", to: 0 });
    });

    it("springs back from a pull released before the ring is full", () => {
        const run = feed(Array(8).fill(12), Last, { every: 30 });
        expect(touchLift(run, Last)).toMatchObject({ commit: 0, kind: "pull" });
    });

    it("cancels a nearly full pull that reverses", () => {
        const run = feed([...Array(14).fill(12), -12, -12, -12, -12, -12, -12], Last);
        expect(released(run)).toHaveLength(0);
        expect(pullProgress(run.state.raw, Last)).toBeLessThan(1);
        expect(touchLift(run, Last).commit).toBe(0);
    });

    it("pulls past the first workspace toward the library", () => {
        const part = feed(Array(10).fill(-12), First, { every: 30 });
        expect(swipeLook(swipeOffset(part.state, part.at, First), part.state.raw, First, false).ring.side).toBe(-1);
        const run = feed(Array(10).fill(-12), First, { state: part.state, start: part.at + 30, every: 30 });
        expect(released(run)).toEqual([expect.objectContaining({ commit: -1, kind: "pull" })]);
    });

    it("goes the other way from an end as a normal swipe", () => {
        const run = feed(Array(10).fill(-9), Last, { every: 30 });
        expect(lift(run, Last).settle).toMatchObject({ commit: -1, kind: "page" });
    });
});

describe("workspace swipe: leaving the new-workspace page and the library (TC-SHELL-203, TC-SHELL-204)", () => {
    it("leaves the new-workspace page by the first swipe back", () => {
        const ctx: SwipeCtx = { width: Width, sides: CreatePageSides };
        const run = feed(Array(10).fill(-9), ctx, { every: 30 });
        expect(run.results[0].grabbed).toBe(true);
        expect(lift(run, ctx).settle).toMatchObject({ commit: -1, kind: "page" });
        const further = feed(Array(30).fill(12), ctx, { every: 30 });
        expect(lift(further, ctx).settle.commit).toBe(0);
    });

    it("leaves the library by the first swipe the other way", () => {
        const ctx: SwipeCtx = { width: Width, sides: LibrarySides };
        const run = feed(Array(10).fill(9), ctx, { every: 30 });
        expect(lift(run, ctx).settle).toMatchObject({ commit: 1, kind: "page" });
        const wrong = feed(Array(30).fill(-12), ctx, { every: 30 });
        expect(lift(wrong, ctx).settle.commit).toBe(0);
    });
});

describe("workspace swipe: reduced motion (TC-SHELL-205)", () => {
    it("slides nothing and fades no tint, the ring still fills", () => {
        const page = swipeLook(80, 80, Middle, true);
        expect(page).toMatchObject({ pageX: 0, neighbour: null, tint: 0, ring: null });
        const pull = swipeLook(trackOffset(PullTravelPx / 2, Last), PullTravelPx / 2, Last, true);
        expect(pull.pageX).toBe(0);
        expect(pull.ring).toEqual({ side: 1, progress: ringFill(PullTravelPx / 2), ready: false });
    });
});

describe("workspace swipe: the pull follows the fingers, not time (#1261)", () => {
    it("holds the ring while the fingers rest, with no event (TC-SHELL-213)", () => {
        const run = feed(fingers(110), Last, { every: 16 });
        const ring = ringOf(run.state, run.at, Last);
        expect(ring).toBeGreaterThan(0.3);
        expect(ring).toBeLessThan(1);
        // Past the old 90 ms release and up to the hold's end, nothing moves.
        for (const pause of [ReleaseGapMs + 10, StrokeGapMs + 10, 1000, PullHoldMs]) {
            const r = swipeTick(run.state, run.at + pause, Last);
            expect(r.released).toBeUndefined();
            expect(r.state.phase).toBe("tracking");
            expect(ringOf(r.state, run.at + pause, Last)).toBe(ring);
        }
        // Then it drains slowly, and lets go once empty.
        const half = run.at + PullHoldMs + PullDrainMs / 2;
        expect(ringOf(swipeTick(run.state, half, Last).state, half, Last)).toBeLessThan(ring);
        expect(ringOf(swipeTick(run.state, half, Last).state, half, Last)).toBeGreaterThan(0);
        const gone = swipeTick(run.state, run.at + PullHoldMs + PullDrainMs, Last);
        expect(gone.state.phase).toBe("idle");
        expect(gone.released).toBeUndefined();
    });

    it("picks the held ring up where it stands, and lets it go when the fingers come back the other way", () => {
        const run = feed(fingers(110), Last, { every: 16 });
        const held = run.state.raw;
        const again = feed([4, 6], Last, { state: run.state, start: run.at + 300 });
        expect(again.state.raw).toBe(held + 10);
        const back = feed([-4, -6], Last, { state: run.state, start: run.at + 300 });
        expect(back.results[0].grabbed).toBe(true);
        expect(back.state.raw).toBe(-10);
    });

    it("lets go when the fingers lift, and opens as soon as the ring is full (TC-SHELL-214, #1312)", () => {
        const half = feed(fingers(110), Last, { every: 16 });
        const s = swipeTouch(half.state, "begin", half.at - 1, Last).state;
        expect(swipeTick(s, half.at + 5000, Last).state.phase).toBe("tracking");
        const early = swipeTouch(s, "end", half.at + 5000, Last);
        expect(early.released).toMatchObject({ commit: 0, kind: "pull" });
        // Without a touch source as with one, the fingers open it the moment they fill the ring, without lifting.
        for (const state of [initialSwipeState(), swipeTouch(initialSwipeState(), "begin", 999, Last).state]) {
            const full = feed(fingers(PullTravelPx + 60), Last, { every: 16, state });
            const opened = full.results.findIndex((r) => r.released != null);
            expect(full.results[opened].released).toMatchObject({ commit: 1, kind: "pull" });
            const before = full.results[opened - 1].state;
            expect(pullProgress(before.raw, Last)).toBeLessThan(1);
            expect(full.results.slice(opened + 1).every((r) => r.released == null && !r.grabbed)).toBe(true);
        }
    });

    it("never adds momentum to the ring, and a fling past the end opens nothing (TC-SHELL-215)", () => {
        const pulled = feed(fingers(150, 20), Last, { every: 8 });
        const before = ringOf(pulled.state, pulled.at, Last);
        const fling = feed(momentum(20, 60), Last, { state: pulled.state, start: pulled.at + 8 });
        const settles = released(fling);
        expect(settles).toHaveLength(1);
        expect(settles[0].commit).toBe(0);
        // Once the momentum is told apart, the ring never shows more than the fingers gave it.
        const told = fling.results.findIndex((r) => r.released != null);
        fling.results.slice(told).forEach((r, i) => {
            expect(ringOf(r.state, pulled.at + 8 * (told + i + 1), Last)).toBeLessThanOrEqual(before + 1e-9);
        });
        // A fling hard enough to fill the ring many times over still opens nothing.
        const hard = feed([...fingers(120, 40), ...momentum(40, 80)], Last, { every: 8 });
        expect(released(hard).every((r) => r.commit === 0)).toBe(true);
        expect(lift(hard, Last).state.phase).not.toBe("tracking");
    });

    it("absorbs the momentum after a known lift: it never starts a pull", () => {
        const run = feed(fingers(110), Last, { every: 16 });
        const lifted = swipeTouch(run.state, "end", run.at + 4, Last).state;
        const tail = feed(momentum(12, 40), Last, { state: lifted, start: run.at + 8 });
        expect(tail.results.every((r) => !r.grabbed)).toBe(true);
        expect(tail.results.every((r) => r.state.phase !== "tracking")).toBe(true);
    });
});

describe("workspace swipe: nothing slides past either end (#1261, TC-SHELL-216)", () => {
    it("moves a few pixels at most past the last and the first workspace, the library and the new-workspace page", () => {
        expect(RubberMaxPx).toBeLessThanOrEqual(8);
        const library: SwipeCtx = { width: Width, sides: LibrarySides };
        const create: SwipeCtx = { width: Width, sides: CreatePageSides };
        for (const [ctx, way] of [
            [Last, 1],
            [First, -1],
            [library, -1],
            [create, 1],
        ] as const) {
            const run = feed(Array(200).fill(way * 30), ctx, { every: 30 });
            const offset = swipeOffset(run.state, run.at, ctx);
            expect(Math.abs(offset)).toBeLessThanOrEqual(RubberMaxPx);
            expect(Math.abs(swipeLook(offset, run.state.raw, ctx, false).pageX)).toBeLessThanOrEqual(RubberMaxPx);
            expect(swipeLook(offset, run.state.raw, ctx, false).neighbour).toBeNull();
        }
    });
});

describe("workspace swipe: the geared ring (#1261, TC-SHELL-217)", () => {
    it("fills over one comfortable stroke (180 to 200 px, #1312), and slows down near full", () => {
        expect(PullTravelPx).toBeGreaterThanOrEqual(180);
        expect(PullTravelPx).toBeLessThanOrEqual(200);
        expect(pullProgress(PullTravelPx / 2, Last)).toBeLessThan(0.8);
        expect(pullProgress(PullTravelPx - 1, Last)).toBeLessThan(1);
        expect(pullProgress(PullTravelPx, Last)).toBe(1);
        const step = 20;
        const early = ringFill(step) - ringFill(0);
        const late = ringFill(PullTravelPx) - ringFill(PullTravelPx - step);
        expect(late).toBeLessThan(early / 2);
        expect(late).toBeGreaterThan(0);
    });
});

describe("workspace swipe: one switch per gesture (#1261, TC-SHELL-218)", () => {
    it("never switches again from the momentum that reaches the view after a pause", () => {
        const first = feed([...fingers(120, 14), ...momentum(14, 6)], Middle);
        expect(released(first).filter((s) => s.commit !== 0)).toHaveLength(1);
        // The view swap stalls the events: the momentum's rest comes after a pause, and in the view the switch reached.
        for (const state of [first.state, arrivedSwipeState(null)]) {
            const rest = feed(momentum(12, 40), Middle, { state, start: first.at + FreshTouchGapMs + 30 });
            const tail = lift(rest, Middle);
            const commits = [...released(rest), tail.settle].filter((s) => s != null && s.commit !== 0);
            expect(commits).toHaveLength(0);
        }
        // A dropped frame coalesces two deltas: still the momentum.
        const coalesced = feed([12, 22, 10, 9, 8, 7, 6, 5], Middle, { start: 5000 });
        expect([...released(coalesced), lift(coalesced, Middle).settle].every((s) => s.commit === 0)).toBe(true);
    });

    it("tells the momentum's shape from fingers that speed up", () => {
        expect(momentumOnly({ count: 5, peak: 14, peakAt: 0, atPeak: 2, last: 9 })).toBe(true);
        expect(momentumOnly({ count: 5, peak: 14, peakAt: 3, atPeak: 1, last: 9 })).toBe(false);
        expect(momentumOnly({ count: 3, peak: 14, peakAt: 0, atPeak: 1, last: 9 })).toBe(false);
        expect(momentumOnly({ count: 8, peak: 9, peakAt: 0, atPeak: 8, last: 9 })).toBe(false);
        expect(momentumOnly({ count: 12, peak: 10, peakAt: 0, atPeak: 8, last: 6 })).toBe(false);
    });
});

// A recorded-like trace: each step is the time since the previous event and the delta.
type Step = { gap: number; dx: number };

// Slow fingers: small deltas, most of them 100 to 150 ms apart, some a frame apart.
function slowStroke(total: number, deltas = [3, 4, 5, 4, 2], gaps = [110, 16, 150, 100, 16, 130]): Step[] {
    const out: Step[] = [];
    let left = Math.abs(total);
    for (let i = 0; left > 0; i++) {
        const dx = Math.min(deltas[i % deltas.length], left);
        out.push({ gap: i === 0 ? 0 : gaps[i % gaps.length], dx: Math.sign(total) * dx });
        left -= dx;
    }
    return out;
}

const steady = (dxs: number[], gap = 8): Step[] => dxs.map((dx) => ({ gap, dx }));
const rest = (ms: number, then: Step[]): Step[] => [{ gap: ms, dx: then[0].dx }, ...then.slice(1)];

type Replay = Run & { ats: number[] };

// Every release of a run, the fingers' lift after its last event included.
function settlesOf(run: Run, ctx: SwipeCtx): { state: SwipeState; settles: SwipeSettle[] } {
    const end = swipeTick(run.state, run.at + StrokeGapMs, ctx);
    return { state: end.state, settles: [...released(run), end.released].filter((s) => s != null) };
}

// Replays a trace from a state; swipeTick runs every frame between events, as the view's timer does.
function replay(steps: Step[], ctx: SwipeCtx, state = initialSwipeState(), start = 1000): Replay {
    let s = state;
    let at = start;
    const results: SwipeResult[] = [];
    const ats: number[] = [];
    for (const step of steps) {
        for (let t = at + 16; t < at + step.gap; t += 16) {
            const r = swipeTick(s, t, ctx);
            s = r.state;
            results.push(r);
            ats.push(t);
        }
        at += step.gap;
        const r = swipeWheel(s, { dx: step.dx, dy: 0, at }, ctx);
        s = r.state;
        results.push(r);
        ats.push(at);
    }
    return { state: s, at, results, ats };
}

describe("workspace swipe: recorded-like traces (#1312)", () => {
    it("opens the pull as soon as a slow stroke with 100–150 ms gaps fills the ring, never cut into a release", () => {
        for (const [ctx, way] of [
            [Last, 1],
            [First, -1],
        ] as const) {
            const run = replay(slowStroke(way * (PullTravelPx + 40)), ctx);
            const r = released(run);
            expect(r).toHaveLength(1);
            expect(r[0]).toMatchObject({ commit: way, kind: "pull" });
            // The ring only grew until it opened: no gap read as a release, no drain.
            const opened = run.results.findIndex((x) => x.released != null);
            let previous = 0;
            run.results.slice(0, opened).forEach((x, i) => {
                const ring = ringOf(x.state, run.ats[i], ctx);
                expect(ring).toBeGreaterThanOrEqual(previous - 1e-9);
                previous = ring;
            });
            expect(previous).toBeLessThan(1);
        }
    });

    it("holds a pull through a 1 s rest before full, then opens when the stroke goes on", () => {
        const first = replay(slowStroke(90), Last);
        const ring = ringOf(first.state, first.at, Last);
        const resting = swipeTick(first.state, first.at + 1000, Last);
        expect(resting.released).toBeUndefined();
        expect(ringOf(resting.state, first.at + 1000, Last)).toBe(ring);
        const after = replay(rest(1000, steady(fingers(PullTravelPx - 90 + 20))), Last, first.state, first.at);
        expect(released(after)).toEqual([expect.objectContaining({ commit: 1, kind: "pull" })]);
        // A rest past the hold drains it instead (about 1.5 s, then 900 ms).
        expect(
            ringOf(swipeTick(first.state, first.at + PullHoldMs - 1, Last).state, first.at + PullHoldMs - 1, Last)
        ).toBe(ring);
        expect(swipeTick(first.state, first.at + PullHoldMs + PullDrainMs, Last).state.phase).toBe("idle");
    });

    it("opens a ring the fingers filled before a pause, at the pause", () => {
        // Fingers slowing down at full: those deltas may be the momentum's first, so it waits for the pause.
        const run = replay(steady([2, 5, 8, ...Array(12).fill(14), 13]), Last);
        expect(released(run)).toHaveLength(0);
        expect(pullProgress(run.state.raw, Last)).toBe(1);
        const r = swipeTick(run.state, run.at + ReleaseGapMs, Last);
        expect(r.released).toMatchObject({ commit: 1, kind: "pull" });
    });

    it("never opens from a fast flick's momentum", () => {
        for (const [ctx, way] of [
            [Last, 1],
            [First, -1],
        ] as const) {
            const flick = replay(steady([...fingers(way * 70, 30), ...momentum(30, 60).map((v) => way * v)]), ctx);
            expect(settlesOf(flick, ctx).settles.every((s) => s.commit === 0)).toBe(true);
        }
    });

    it("absorbs the rest of the gesture once the pull opened, then takes the next swipe back", () => {
        const run = replay(steady(fingers(PullTravelPx + 10)), Last);
        expect(released(run)).toHaveLength(1);
        // The controller now reads the new-workspace page: the fingers that go on, or wiggle back, belong to the pull.
        const create: SwipeCtx = { width: Width, sides: CreatePageSides };
        const tail = replay(slowStroke(-60, [12, 12, 10], [8, 120, 140]), create, run.state, run.at);
        expect(tail.results.every((r) => !r.grabbed && r.released == null)).toBe(true);
        const back = replay(rest(StrokeGapMs + 50, steady(fingers(-120))), create, tail.state, tail.at);
        expect(back.results.find((r) => r.grabbed)).toBeDefined();
        expect(lift(back, create).settle).toMatchObject({ commit: -1, kind: "page" });
    });

    it("commits a slow page swipe whose strokes pause and slow down, with no spring back mid-gesture", () => {
        // The recording: a slow swipe back from the new-workspace page, its last stroke slowing down after a pause.
        const create: SwipeCtx = { width: Width, sides: CreatePageSides };
        for (const ctx of [create, Middle]) {
            const trace = [...slowStroke(-70), ...rest(140, steady([-8, -7, -6, -5, -4]))];
            const run = replay(trace, ctx);
            const { settles } = settlesOf(run, ctx);
            expect(settles).toHaveLength(1);
            expect(settles[0]).toMatchObject({ commit: -1, kind: "page" });
        }
    });

    it("keeps a commit made at a pause when the same stroke comes back during its settle", () => {
        // Replayed in the built app: past 35 % a pause commits, the stroke goes on and takes the settle back; its last,
        // slowing deltas must not read as momentum and spring the page back (the recording's bounce).
        const create: SwipeCtx = { width: Width, sides: CreatePageSides };
        for (const ctx of [create, Middle]) {
            const trace = [...slowStroke(-110), ...rest(140, steady([-8, -7, -6, -5, -4]))];
            const { settles } = settlesOf(replay(trace, ctx), ctx);
            expect(settles.length).toBeGreaterThan(0);
            expect(settles.every((s) => s.commit === -1)).toBe(true);
        }
        // A fresh gesture the other way during the settle still cancels it.
        const run = replay([...slowStroke(-110), ...steady(fingers(120))], Middle);
        expect(settlesOf(run, Middle).settles.at(-1).commit).not.toBe(-1);
    });

    it("springs a short slow page swipe back once the fingers stay away, not at the first gap", () => {
        const run = replay(slowStroke(30), Middle);
        expect(released(run)).toHaveLength(0);
        expect(swipeTick(run.state, run.at + 150, Middle).released).toBeUndefined();
        expect(swipeTick(run.state, run.at + StrokeGapMs, Middle).released).toMatchObject({ commit: 0 });
    });

    it("still switches back and forth between workspaces, one switch per gesture", () => {
        let state = initialSwipeState();
        let at = 1000;
        const commits: number[] = [];
        for (const way of [1, -1, 1, -1]) {
            const run = replay(
                steady([...fingers(way * 90, 14), ...momentum(14, 30).map((v) => way * v)]),
                Middle,
                state,
                at
            );
            const end = settlesOf(run, Middle);
            commits.push(...end.settles.filter((s) => s.commit !== 0).map((s) => s.commit));
            state = end.state;
            at = run.at + 200;
        }
        expect(commits).toEqual([1, -1, 1, -1]);
    });
});

describe("sidebar bottom bar", () => {
    it("steps and jumps along the bottom bar's order", () => {
        const ids = ["a", "b", "c"];
        expect(stepTarget(ids, "b", 1)).toBe("c");
        expect(stepTarget(ids, "a", -1)).toBeNull();
        expect(workspaceAtNumber(ids, 3)).toBe("c");
        expect(workspaceAtNumber(ids, 4)).toBeNull();
        expect(workspaceAtNumber(ids, 0)).toBeNull();
        expect(switchDirection(ids, "c", "a")).toBe(-1);
        expect(switchDirection(ids, "a", "b")).toBe(1);
        expect(workspaceSides(0, 1)).toEqual({ prev: "pull", next: "pull" });
    });

    it("shrinks the dots past seven and centres the current one within the scroll range", () => {
        expect(manyDots(7)).toBe(false);
        expect(manyDots(8)).toBe(true);
        expect(centredScroll(300, 24, 160, 400)).toBe(232);
        expect(centredScroll(10, 24, 160, 400)).toBe(0);
        expect(centredScroll(390, 24, 160, 400)).toBe(240);
    });
});

describe("sidebar switch record", () => {
    it("is read back only for the workspace it went to, while fresh", () => {
        const raw = JSON.stringify({ workspaceId: "w2", direction: -1, from: "rgb(1, 2, 3)", at: 100 });
        const intent = parseSwitchIntent(raw);
        expect(intent).toMatchObject({ workspaceId: "w2", direction: -1, from: "rgb(1, 2, 3)", at: 100 });
        expect(isArrival(intent, "w2", 200)).toBe(true);
        expect(isArrival(intent, "w1", 200)).toBe(false);
        expect(isArrival(intent, "w2", 100 + SwitchIntentMaxAgeMs)).toBe(false);
        expect(parseSwitchIntent("not json")).toBeNull();
        expect(parseSwitchIntent(JSON.stringify({ at: 1 }))).toBeNull();
    });

    it("lets the view a swipe reached take the spring up where it stands", () => {
        const intent = parseSwitchIntent(
            JSON.stringify({ workspaceId: "w2", direction: 1, from: "", at: 1000, offset: 0.5, v0: 0.2 })
        );
        expect(intent).toMatchObject({ offset: 0.5, v0: 0.2 });
        // Half-way when the switch was asked: the new page stood half a width to the right.
        expect(arrivalOffset(intent, Width, 1000)).toBeCloseTo(Width / 2);
        expect(arrivalOffset(intent, Width, 1000 + SettleMs)).toBe(0);
        const key = parseSwitchIntent(JSON.stringify({ workspaceId: "w2", direction: -1, at: 1000 }));
        expect(arrivalOffset(key, Width, 1000)).toBe(-Width);
    });
});

describe("⌥1…⌥9", () => {
    it("binds the digit codes on macOS only (Alt+digit is the tab's elsewhere)", () => {
        expect(workspaceNumberBindings(true)).toHaveLength(9);
        expect(workspaceNumberBindings(true)[0]).toBe("Alt:c{Digit1}");
        expect(workspaceNumberBindings(false)).toEqual([]);
    });
});

describe("new-workspace page", () => {
    it("starts in a colour no workspace uses, and shows the letter typed", () => {
        expect(freshColour([CreateColours[1], CreateColours[2]], 2)).toBe(CreateColours[3]);
        expect(freshColour(CreateColours, 3)).toBe(CreateColours[5]);
        expect(makeCreateDraft("").colour).toBe(CreateColours[2]);
        expect(pendingLetter("")).toBe("+");
        expect(pendingLetter("  notulia")).toBe("N");
        expect(pendingLetter("été")).toBe("É");
        expect(typeSuggestions("SaaS, CLI ,, API")).toEqual(["SaaS", "CLI", "API"]);
    });
});
