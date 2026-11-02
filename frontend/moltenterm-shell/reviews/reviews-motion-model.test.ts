// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";
import { ArrivalLimit, CardPlace, layoutSignature, motionPlan, ReviewsSeen } from "./reviews-motion-model";

const yours = (...numbers: number[]): CardPlace[] => numbers.map((number) => ({ number, section: "yours" }));

describe("ReviewsSeen (#1063)", () => {
    beforeEach(() => ReviewsSeen.resetInstance());

    it("animates nothing on the panel's first display", () => {
        expect(ReviewsSeen.getInstance().note("/p", [1, 2, 3], true)).toEqual([]);
        expect(ReviewsSeen.getInstance().note("/p", [1, 2, 3], false)).toEqual([]);
    });

    it("returns a card the first time it is listed, then never again", () => {
        const seen = ReviewsSeen.getInstance();
        seen.note("/p", [1, 2], true);
        expect(seen.note("/p", [3, 1, 2], false)).toEqual([3]);
        expect(seen.note("/p", [3, 1, 2], false)).toEqual([]);
        // A refresh that drops then lists the card again replays nothing.
        seen.note("/p", [1, 2], false);
        expect(seen.note("/p", [1, 2, 3], false)).toEqual([]);
    });

    it("keeps the seen cards across a remount of the view (coming back to the tab)", () => {
        ReviewsSeen.getInstance().note("/p", [1], true);
        ReviewsSeen.getInstance().note("/p", [1, 2], false);
        expect(ReviewsSeen.getInstance().note("/p", [1, 2], true)).toEqual([]);
        expect(ReviewsSeen.getInstance().note("/p", [1, 2], false)).toEqual([]);
    });

    it("notes a card that arrives while the view mounts again, without playing it", () => {
        ReviewsSeen.getInstance().note("/p", [1], true);
        expect(ReviewsSeen.getInstance().note("/p", [1, 2], true)).toEqual([]);
        expect(ReviewsSeen.getInstance().note("/p", [1, 2], false)).toEqual([]);
    });

    it("keeps one set per project", () => {
        const seen = ReviewsSeen.getInstance();
        seen.note("/a", [1], true);
        seen.note("/b", [7], true);
        expect(seen.note("/a", [1, 7], false)).toEqual([7]);
        expect(seen.note("/b", [1, 7], false)).toEqual([1]);
    });
});

describe("motionPlan (#1063)", () => {
    it("plays the arrival of a fresh card and slides the others", () => {
        expect(motionPlan(yours(1, 2), yours(3, 1, 2), [3])).toEqual({
            arrive: [3],
            leave: [],
            slide: [1, 2],
            travel: [],
        });
    });

    it("plays no arrival past the limit of cards arriving at once", () => {
        const many = Array.from({ length: ArrivalLimit + 1 }, (_, i) => 10 + i);
        expect(motionPlan(yours(1), yours(...many, 1), many).arrive).toEqual([]);
        const few = many.slice(0, ArrivalLimit);
        expect(motionPlan(yours(1), yours(...few, 1), few).arrive).toEqual(few);
    });

    it("plays no arrival for a card already seen", () => {
        expect(motionPlan(yours(1), yours(2, 1), []).arrive).toEqual([]);
    });

    it("says which cards leave", () => {
        expect(motionPlan(yours(1, 2, 3), yours(1, 3), [])).toEqual({
            arrive: [],
            leave: [2],
            slide: [1, 3],
            travel: [],
        });
    });

    it("tells a change of section from a reorder", () => {
        const prev: CardPlace[] = [...yours(1, 2), { number: 3, section: "agents" }];
        const next: CardPlace[] = [...yours(2), { number: 1, section: "agents" }, { number: 3, section: "agents" }];
        expect(motionPlan(prev, next, [])).toEqual({ arrive: [], leave: [], slide: [2, 3], travel: [1] });
    });

    it("changes the signature only when the data's layout changes", () => {
        expect(layoutSignature(yours(1, 2))).toBe(layoutSignature(yours(1, 2)));
        expect(layoutSignature(yours(1, 2))).not.toBe(layoutSignature(yours(2, 1)));
        expect(layoutSignature(yours(1))).not.toBe(layoutSignature([{ number: 1, section: "agents" }]));
    });
});
