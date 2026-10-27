// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { CreateColours, freshColour, makeCreateDraft, pendingLetter, typeSuggestions } from "./sidebar-create-model";
import { workspaceNumberBindings } from "./sidebar-keys";
import {
    centredScroll,
    GestureGapMs,
    initialSwipeState,
    manyDots,
    pullLook,
    PullPx,
    stepTarget,
    SwipeAction,
    SwipeIdleMs,
    SwipeState,
    swipeStep,
    SwitchMomentumMs,
    workspaceAtNumber,
} from "./sidebar-swipe";
import { isArrival, parseSwitchIntent, switchDirection, SwitchIntentMaxAgeMs } from "./sidebar-switch";

// Feeds wheel events of dx every 16 ms from `start` and returns the actions seen and the last state.
function feed(
    dxs: number[],
    pos: { index: number; count: number },
    opts: { start?: number; state?: SwipeState; switchedAt?: number } = {}
): { actions: SwipeAction[]; state: SwipeState; at: number } {
    let state = opts.state ?? initialSwipeState();
    let at = opts.start ?? 1000;
    const actions: SwipeAction[] = [];
    for (const dx of dxs) {
        const r = swipeStep(state, { dx, dy: 0, at }, pos, opts.switchedAt ?? 0);
        state = r.state;
        actions.push(r.action);
        at += 16;
    }
    return { actions, state, at };
}

const kinds = (actions: SwipeAction[]) => actions.map((a) => a.kind).filter((k) => k !== "none");

describe("sidebar swipe (FR-SHELL-082)", () => {
    it("leaves vertical scrolling alone", () => {
        const r = swipeStep(initialSwipeState(), { dx: 5, dy: 40, at: 10 }, { index: 1, count: 3 });
        expect(r.handled).toBe(false);
        expect(r.action.kind).toBe("none");
    });

    it("moves one workspace per gesture, its momentum included", () => {
        const { actions } = feed(Array(60).fill(12), { index: 1, count: 5 });
        expect(actions.filter((a) => a.kind === "switch")).toEqual([{ kind: "switch", direction: 1 }]);
        const back = feed(Array(10).fill(-12), { index: 1, count: 5 });
        expect(back.actions.filter((a) => a.kind === "switch")).toEqual([{ kind: "switch", direction: -1 }]);
    });

    it("listens again after the gesture's momentum stops", () => {
        const first = feed(Array(10).fill(12), { index: 1, count: 5 });
        const second = feed(
            Array(10).fill(12),
            { index: 2, count: 5 },
            { start: first.at + GestureGapMs, state: first.state }
        );
        expect(kinds(second.actions)).toEqual(["switch"]);
    });

    it("forgets a small move after a pause", () => {
        const small = feed([30, 30], { index: 1, count: 5 });
        const later = feed([30], { index: 1, count: 5 }, { start: small.at + SwipeIdleMs + 1, state: small.state });
        expect(kinds(later.actions)).toEqual([]);
        expect(later.state.acc).toBe(30);
    });

    it("ignores the momentum that reaches the new workspace's view after a switch", () => {
        const switchedAt = 5000;
        const momentum = feed(Array(30).fill(10), { index: 2, count: 5 }, { start: switchedAt + 300, switchedAt });
        expect(kinds(momentum.actions)).toEqual([]);
        const fresh = feed(
            Array(10).fill(12),
            { index: 2, count: 5 },
            { start: switchedAt + SwitchMomentumMs + 500, switchedAt }
        );
        expect(kinds(fresh.actions)).toEqual(["switch"]);
    });

    it("pulls past the first workspace toward the library, past the last toward a new one", () => {
        const left = feed(Array(20).fill(-12), { index: 0, count: 3 });
        expect(left.actions.find((a) => a.kind === "pull")).toMatchObject({ kind: "pull", side: -1 });
        expect(kinds(left.actions)).toContain("pulled");
        expect(left.actions.find((a) => a.kind === "pulled")).toEqual({ kind: "pulled", side: -1 });
        const right = feed(Array(20).fill(12), { index: 2, count: 3 });
        expect(right.actions.find((a) => a.kind === "pulled")).toEqual({ kind: "pulled", side: 1 });
        expect(kinds(right.actions)).not.toContain("switch");
    });

    it("opens only once the pull is long enough; a short one does nothing", () => {
        const steps = Math.floor((PullPx - 1) / 12);
        const short = feed(Array(steps).fill(12), { index: 0, count: 1 });
        expect(kinds(short.actions).every((k) => k === "pull")).toBe(true);
        const last = short.actions[short.actions.length - 1];
        expect(last.kind === "pull" && last.amount < 1).toBe(true);
    });

    it("draws the pull: the indicator grows from its side, the content follows up to 30 px", () => {
        expect(pullLook(-1, 0)).toMatchObject({ opacity: 0, scale: 0.4, shiftX: -16, ready: false });
        expect(pullLook(1, 0.5)).toMatchObject({ scale: 0.7, shiftX: 8, contentX: -15 });
        expect(pullLook(-1, 1)).toMatchObject({ opacity: 1, scale: 1.12, contentX: 30, ready: true });
    });

    it("steps and jumps along the bottom bar's order", () => {
        const ids = ["a", "b", "c"];
        expect(stepTarget(ids, "b", 1)).toBe("c");
        expect(stepTarget(ids, "a", -1)).toBeNull();
        expect(workspaceAtNumber(ids, 3)).toBe("c");
        expect(workspaceAtNumber(ids, 4)).toBeNull();
        expect(workspaceAtNumber(ids, 0)).toBeNull();
        expect(switchDirection(ids, "c", "a")).toBe(-1);
        expect(switchDirection(ids, "a", "b")).toBe(1);
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
        expect(intent).toEqual({ workspaceId: "w2", direction: -1, from: "rgb(1, 2, 3)", at: 100 });
        expect(isArrival(intent, "w2", 200)).toBe(true);
        expect(isArrival(intent, "w1", 200)).toBe(false);
        expect(isArrival(intent, "w2", 100 + SwitchIntentMaxAgeMs)).toBe(false);
        expect(parseSwitchIntent("not json")).toBeNull();
        expect(parseSwitchIntent(JSON.stringify({ at: 1 }))).toBeNull();
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
