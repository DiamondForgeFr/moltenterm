// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A security fix goes first in the suggested merge order, with the reason it unblocks the pull requests the shared
// dependency scan block holds (FR-REV-036 AC17, #2591).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { wordPhrase } from "../i18n/phrase";
import { batchPlan, queueOrder } from "./reviews-batch-model";
import type { Forecast, ForecastRow } from "./reviews-forecast-model";
import type { ReviewPr } from "./reviews-model";
import { mergeOrderReason, putFirst, suggestedMergeOrder } from "./reviews-order-model";
import { mergeQueue, queueAfterFix, queueRanks, queueWhy } from "./reviews-queue-model";

const Base = "b".repeat(40);
const head = (n: number) => `h${n}`.padEnd(40, "0");

function pr(number: number, extra: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/acme/shop/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        headoid: head(number),
        baseoid: Base,
        createdat: "2026-10-20T10:00:00Z",
        updatedat: "2026-10-24T10:00:00Z",
        merge: "clean",
        ci: { state: "success", success: 4, failure: 0, pending: 0, checks: [] },
        report: { state: "present" },
        unpublished: 0,
        ...extra,
    };
}

function impact(number: number) {
    return { number, headoid: head(number), paths: ["go.mod"], pathcount: 1 };
}

function row(number: number, impacts: ReturnType<typeof impact>[] = []): ForecastRow {
    return { number, headoid: head(number), state: "simulated", impacts };
}

// #1201 ↔ #1202 a pair on go.mod; #1203 ↔ #1204 another pair on go.mod, #1204 being the security fix; #1206 alone.
const Ready = [pr(1201), pr(1202), pr(1203), pr(1204), pr(1206)];
const Forecasted: Forecast = {
    dir: "/shop",
    key: "k",
    state: "ready",
    baseoid: Base,
    method: "merge",
    uptodate: "notrequired",
    rows: [
        row(1201, [impact(1202)]),
        row(1202, [impact(1201)]),
        row(1203, [impact(1204)]),
        row(1204, [impact(1203)]),
        row(1206),
    ],
};

// Merging #1204 unblocks #1301 and #1302, which fail the shared scan.
const First = { 1204: [1301, 1302] };

describe("a security fix goes first in the merge order (FR-REV-036 AC17, #2591)", () => {
    let locale: string;
    beforeAll(() => {
        locale = I18nModel.getInstance().getLocale();
        I18nModel.getInstance().setLanguageSetting("en");
    });
    afterAll(() => I18nModel.getInstance().setLanguageSetting(locale));

    it("ranks the fix first, whatever the forecast would have chosen, and counts the rebases that order makes", () => {
        const plain = mergeQueue(Forecasted, Ready, Ready);
        const first = mergeQueue(Forecasted, Ready, Ready, undefined, undefined, First);
        expect(plain.steps[0].number).not.toBe(1204);
        expect(first.steps[0]).toMatchObject({ number: 1204, rank: 1, unblocks: [1301, 1302] });
        expect(first.steps.map((s) => s.rank)).toEqual([1, 2, 3, 4, 5]);
        expect(first.steps.map((s) => s.number).sort()).toEqual([1201, 1202, 1203, 1204, 1206]);
        // #1203 merges after #1204, whose go.mod it shares: it is rebased.
        expect(first.steps.find((s) => s.number === 1203).rebase).toBe(true);
        expect(first.cost).toBe(first.steps.filter((s) => s.rebase).length);
        expect(queueRanks(first)[1204]).toBe(1);
    });

    it("says why: it unblocks the pull requests the security block holds, by their PR numbers", () => {
        const queue = mergeQueue(Forecasted, Ready, Ready, undefined, undefined, First);
        expect(wordPhrase(queueWhy(queue, 1204, []))).toBe("unblocks #1301 and #1302");
        expect(queue.steps.slice(1).every((s) => s.unblocks == null)).toBe(true);
    });

    it("tells a step that follows the fix and needs no rebase for it", () => {
        const queue = mergeQueue(Forecasted, Ready, Ready, undefined, undefined, First);
        expect(wordPhrase(queueAfterFix(queue, 1206))).toBe("after #1204: nothing to rebase");
        // rebased after it: the card says so in its own words
        expect(queueAfterFix(queue, 1203)).toBeNull();
        expect(queueAfterFix(queue, 1204)).toBeNull();
        expect(queueAfterFix(mergeQueue(Forecasted, Ready, Ready), 1206)).toBeNull();
        expect(queueAfterFix(null, 1206)).toBeNull();
    });

    it("keeps it first while the forecast cannot say", () => {
        const queue = mergeQueue(null, Ready, Ready, undefined, undefined, First);
        expect(queue.usable).toBe(false);
        expect(queue.steps.map((s) => s.number)).toEqual([1204, 1201, 1202, 1203, 1206]);
        expect(wordPhrase(queueWhy(queue, 1204, []))).toBe("unblocks #1301 and #1302");
    });

    it("changes nothing when no fix is there to go first, or the fix is no step", () => {
        const plain = mergeQueue(Forecasted, Ready, Ready);
        expect(mergeQueue(Forecasted, Ready, Ready, undefined, undefined, {})).toEqual(plain);
        expect(mergeQueue(Forecasted, Ready, Ready, undefined, undefined, { 1999: [1301] })).toEqual(plain);
    });

    it("puts the fix first in the group merge too, with the reason in the confirmation", () => {
        const order = suggestedMergeOrder(Forecasted, Ready, Ready, First);
        expect(order.numbers[0]).toBe(1204);
        expect(order.steps[0].unblocks).toEqual([1301, 1302]);
        // the reason it unblocks comes first, the forecast's own words follow
        expect(mergeOrderReason(order.steps[0], "develop", Ready[3])).toBe(
            "Unblocks #1301, #1302 · Puts #1203 in conflict"
        );
        const plan = batchPlan(Forecasted, Ready, Ready, "develop", First);
        expect(plan.steps[0]).toMatchObject({ rank: 1, reason: expect.stringMatching(/^Unblocks #1301, #1302/) });
        expect(plan.steps[0].pr.number).toBe(1204);
        expect(queueOrder(Forecasted, Ready, null, [1201, 1204, 1206], First)[0]).toBe(1204);
        expect(queueOrder(Forecasted, Ready, null, [1201, 1204, 1206])[0]).not.toBe(1204);
        expect(putFirst([1, 2, 3], { 3: [9] })).toEqual([3, 1, 2]);
        expect(putFirst([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it("is worded in French", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        try {
            const queue = mergeQueue(Forecasted, Ready, Ready, undefined, undefined, First);
            expect(wordPhrase(queueWhy(queue, 1204, []))).toBe("débloque #1301 et #1302");
            expect(wordPhrase(queueAfterFix(queue, 1206))).toBe("après #1204 : rien à rebaser");
        } finally {
            I18nModel.getInstance().setLanguageSetting("en");
        }
    });
});
