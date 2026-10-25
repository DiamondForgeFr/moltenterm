// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the Reviews cards' motion plays (#1063, FR-REV-001 AC14), decided from data, never from the DOM: the cards seen
// in this session, and from the previous and the next layout of the sections, which cards arrive, leave, slide in
// their section (reordered, or pushed by a neighbour) or travel to another one. reviews-motion.tsx plays the plan.

export const ArrivalLimit = 6;

// Durations and curves of the mockup's "Mouvement des cartes" spec (audit #1054).
export const Motion = {
    ease: "cubic-bezier(0.2, 0, 0, 1)",
    leaveEase: "cubic-bezier(0.4, 0, 1, 1)",
    arriveMs: 220,
    leaveMs: 160,
    reorderMs: 240,
    travelMs: 320,
    reducedMs: 120,
    arriveOffsetPx: 8,
    leaveOffsetPx: 12,
};

// One card in the sections' shown order, with the section it sits in. Folded sections still list their cards: folding
// is not a change of the data, so it never animates.
export type CardPlace = { number: number; section: string };

export type MotionPlan = {
    arrive: number[];
    leave: number[];
    slide: number[];
    travel: number[];
};

export function layoutSignature(layout: CardPlace[]): string {
    return layout.map((p) => `${p.section}:${p.number}`).join(",");
}

// The cards seen in this session, per project folder: a card plays its arrival once, the first time it is listed after
// the panel first showed that project. Kept in a singleton so a poll, a refresh, a re-render or coming back to the view
// (which mounts the list again) replays nothing.
export class ReviewsSeen {
    private static instance: ReviewsSeen = null;

    seen = new Map<string, Set<number>>();

    private constructor() {}

    static getInstance(): ReviewsSeen {
        if (ReviewsSeen.instance == null) {
            ReviewsSeen.instance = new ReviewsSeen();
        }
        return ReviewsSeen.instance;
    }

    static resetInstance(): void {
        ReviewsSeen.instance = null;
    }

    // Notes the listed cards and returns the ones never seen before. On the panel's first display (first), every card
    // is noted and none is returned: the first display animates nothing.
    note(dir: string, numbers: number[], first: boolean): number[] {
        let set = this.seen.get(dir);
        if (set == null) {
            set = new Set();
            this.seen.set(dir, set);
        }
        const fresh = numbers.filter((n) => !set.has(n));
        for (const n of fresh) {
            set.add(n);
        }
        return first ? [] : fresh;
    }
}

export function motionPlan(prev: CardPlace[], next: CardPlace[], fresh: number[]): MotionPlan {
    const before = new Map(prev.map((p) => [p.number, p.section]));
    const nextNumbers = new Set(next.map((p) => p.number));
    const freshSet = new Set(fresh);
    const arrivals = fresh.length <= ArrivalLimit;
    const plan: MotionPlan = { arrive: [], leave: [], slide: [], travel: [] };
    for (const p of next) {
        const was = before.get(p.number);
        if (was == null) {
            if (arrivals && freshSet.has(p.number)) {
                plan.arrive.push(p.number);
            }
            continue;
        }
        if (was !== p.section) {
            plan.travel.push(p.number);
            continue;
        }
        plan.slide.push(p.number);
    }
    for (const p of prev) {
        if (!nextNumbers.has(p.number)) {
            plan.leave.push(p.number);
        }
    }
    return plan;
}
