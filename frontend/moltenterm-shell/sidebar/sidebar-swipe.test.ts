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
    initialSwipeState,
    LibrarySides,
    looksLikeMomentum,
    manyDots,
    PullFullPx,
    pullProgress,
    ReleaseGapMs,
    rubberBand,
    RubberFraction,
    settleFrames,
    SettleMs,
    settleOffset,
    stepTarget,
    SwipeCtx,
    swipeLook,
    swipeOffset,
    SwipeResult,
    SwipeSettle,
    SwipeState,
    swipeTick,
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

// The fingers lift: no more events.
function lift(run: Run, ctx: SwipeCtx): { state: SwipeState; settle: SwipeSettle } {
    const r = swipeTick(run.state, run.at + ReleaseGapMs, ctx);
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

describe("workspace swipe: tracking (FR-SHELL-082, #1248)", () => {
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

describe("workspace swipe: release", () => {
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

describe("workspace swipe: no lost gestures", () => {
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

describe("workspace swipe: past either end", () => {
    it("resists more the further it is pulled, never past its reach", () => {
        const reach = RubberFraction * Width;
        expect(rubberBand(0, reach)).toBe(0);
        const a = rubberBand(50, reach);
        const b = rubberBand(100, reach);
        const c = rubberBand(400, reach);
        expect(a).toBeLessThan(50);
        expect(b - a).toBeLessThan(a);
        expect(c).toBeLessThan(reach);
        expect(rubberBand(-50, reach)).toBe(-a);
        expect(trackOffset(100, Last)).toBeCloseTo(b);
    });

    it("fills the ring with the fingers' travel past the last workspace, and opens the new-workspace page when full", () => {
        expect(pullProgress(PullFullPx / 2, Last)).toBe(0.5);
        expect(pullProgress(PullFullPx / 2, Middle)).toBe(0);
        const look = swipeLook(trackOffset(PullFullPx, Last), PullFullPx, Last, false);
        expect(look.ring).toEqual({ side: 1, progress: 1, ready: true });
        expect(look.shadow).toBeGreaterThan(0);
        expect(look.neighbour).toBeNull();
        const run = feed(Array(16).fill(12), Last, { every: 30 });
        expect(lift(run, Last).settle).toMatchObject({ commit: 1, kind: "pull", to: 0 });
    });

    it("springs back from a pull released before the ring is full", () => {
        const run = feed(Array(8).fill(12), Last, { every: 30 });
        expect(lift(run, Last).settle).toMatchObject({ commit: 0, kind: "pull" });
    });

    it("cancels a full pull that reverses", () => {
        const run = feed([...Array(16).fill(12), -12, -12, -12, -12, -12, -12], Last);
        expect(lift(run, Last).settle.commit).toBe(0);
    });

    it("pulls past the first workspace toward the library", () => {
        const run = feed(Array(16).fill(-12), First, { every: 30 });
        expect(swipeLook(swipeOffset(run.state, run.at, First), run.state.raw, First, false).ring.side).toBe(-1);
        expect(lift(run, First).settle).toMatchObject({ commit: -1, kind: "pull" });
    });

    it("goes the other way from an end as a normal swipe", () => {
        const run = feed(Array(10).fill(-9), Last, { every: 30 });
        expect(lift(run, Last).settle).toMatchObject({ commit: -1, kind: "page" });
    });
});

describe("workspace swipe: leaving the new-workspace page and the library", () => {
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

describe("workspace swipe: reduced motion", () => {
    it("slides nothing and fades no tint, the ring still fills", () => {
        const page = swipeLook(80, 80, Middle, true);
        expect(page).toMatchObject({ pageX: 0, neighbour: null, tint: 0, ring: null });
        const pull = swipeLook(trackOffset(PullFullPx / 2, Last), PullFullPx / 2, Last, true);
        expect(pull.pageX).toBe(0);
        expect(pull.ring).toEqual({ side: 1, progress: 0.5, ready: false });
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
        expect(freshColour([CreateColours[0], CreateColours[1]], 2)).toBe(CreateColours[2]);
        expect(freshColour(CreateColours, 3)).toBe(CreateColours[3]);
        expect(makeCreateDraft("").colour).toBe(CreateColours[0]);
        expect(pendingLetter("")).toBe("+");
        expect(pendingLetter("  notulia")).toBe("N");
        expect(pendingLetter("été")).toBe("É");
        expect(typeSuggestions("SaaS, CLI ,, API")).toEqual(["SaaS", "CLI", "API"]);
    });
});
