// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { wordPhrase } from "../i18n/phrase";
import type { Forecast, ForecastRow } from "./reviews-forecast-model";
import type { ReviewPr, ReviewsAnswer } from "./reviews-model";
import {
    afterMergeOf,
    afterMergeText,
    cardRelations,
    edgeLine,
    forgetMerged,
    joinAfterMerge,
    mergeQueue,
    queueCost,
    queueLegend,
    queueMemory,
    queueRanks,
    queueShown,
    queueWhy,
    withMerged,
} from "./reviews-queue-model";

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

// Audit #1054's acme/shop fixture: #1201 ↔ #1202 a pair on src/theme.ts; #1203 → #1204 → #1205 a chain through
// src/menu.ts then src/palette.ts; #1206 independent; #1207 already conflicts with develop; #1205's CI runs; the draft
// #1208 touches #1201's lines.
const Ready = [
    pr(1201),
    pr(1202),
    pr(1203),
    pr(1204),
    pr(1205, { ci: { state: "pending", success: 2, failure: 0, pending: 2, checks: [] } }),
    pr(1206),
    pr(1207, { merge: "conflicts" }),
];
const Draft = pr(1208, { draft: true });
const Listed = [...Ready, Draft];

function impact(number: number, paths: string[]) {
    return { number, headoid: head(number), paths, pathcount: paths.length };
}

function row(
    number: number,
    impacts: ReturnType<typeof impact>[],
    state: ForecastRow["state"] = "simulated"
): ForecastRow {
    return { number, headoid: head(number), state, impacts };
}

const Shop: Forecast = {
    dir: "/shop",
    key: "k",
    state: "ready",
    baseoid: Base,
    method: "merge",
    uptodate: "notrequired",
    rows: [
        row(1201, [impact(1202, ["src/theme.ts"]), impact(1208, ["src/theme.ts"])]),
        row(1202, [impact(1201, ["src/theme.ts"])]),
        row(1203, [impact(1204, ["src/menu.ts"])]),
        row(1204, [impact(1203, ["src/menu.ts"]), impact(1205, ["src/palette.ts"])]),
        row(1205, [impact(1204, ["src/palette.ts"])]),
        row(1206, []),
        row(1207, [], "conflictsbase"),
        row(1208, []),
    ],
};

describe("merge queue (#1062)", () => {
    let locale: string;
    beforeAll(() => {
        locale = I18nModel.getInstance().getLocale();
        I18nModel.getInstance().setLanguageSetting("en");
    });
    afterAll(() => I18nModel.getInstance().setLanguageSetting(locale));

    it("numbers the queue as the mockup shows it, with its marks and cost", () => {
        const queue = mergeQueue(Shop, Ready, Listed);
        expect(queue.usable).toBe(true);
        expect(queue.steps.map((s) => [s.rank, s.number, s.rebase, s.wait])).toEqual([
            [1, 1206, false, false],
            [2, 1201, false, false],
            [3, 1202, true, false],
            [4, 1203, false, false],
            [5, 1205, false, true],
            [6, 1204, true, false],
        ]);
        expect(queue.outside).toEqual([1207]);
        expect(wordPhrase(queueCost(queue))).toBe("2 rebases instead of 3 in list order");
        expect(wordPhrase(queueLegend(queue, "develop"))).toBe(
            "⟲ rebased by your agent before its merge · ◔ waits for its CI · #1207 out of the queue: already conflicts with develop"
        );
        expect(queueShown(queue)).toBe(true);
        expect(queueRanks(queue)[1204]).toBe(6);
        expect(queueRanks(queue)[1207]).toBeUndefined();
    });

    it("words each card's place in the order's direction", () => {
        const queue = mergeQueue(Shop, Ready, Listed);
        const rel = cardRelations(Shop, Listed, null);
        const why = (n: number) => wordPhrase(queueWhy(queue, n, rel.byCard[n]));
        expect(why(1206)).toBe("touches no other pull request");
        expect(why(1201)).toBe("before #1202");
        expect(why(1202)).toBe("to rebase after #1201");
        expect(why(1203)).toBe("before #1204");
        expect(why(1205)).toBe("the queue will wait for it");
        expect(why(1204)).toBe("to rebase after #1203 and #1205");
        expect(queueWhy(queue, 1207, rel.byCard[1207])).toBeNull();
    });

    it("keeps failing and blocked PRs out of the steps, and says the cost when the order saves nothing", () => {
        const failing = pr(1209, {
            merge: "failing",
            ci: { state: "failure", success: 1, failure: 1, pending: 0, checks: [] },
        });
        const queue = mergeQueue(Shop, [pr(1206), pr(1201), failing], [pr(1206), pr(1201), failing]);
        expect(queue.steps.map((s) => s.number)).toEqual([1206, 1201]);
        expect(wordPhrase(queueCost(queue))).toBe("no rebase needed");
        expect(queueLegend(queue, "develop")).toBeNull();
    });

    it("keeps the list order while the forecast cannot say, without marks it does not know", () => {
        const queue = mergeQueue(null, Ready, Listed);
        expect(queue.usable).toBe(false);
        expect(queue.steps.map((s) => s.number)).toEqual([1201, 1202, 1203, 1204, 1205, 1206]);
        expect(queue.steps.find((s) => s.number === 1205).wait).toBe(true);
        expect(queue.outside).toEqual([1207]);
        expect(queueCost(queue)).toBeNull();
    });

    it("lights the cards related to the hovered one, both ways, with an edge line for the draft lower down", () => {
        const rel = cardRelations(Shop, Listed, 1201);
        expect(rel.partners.map((p) => p.number)).toEqual([1202, 1208]);
        expect(rel.cards[1201].role).toBe("source");
        expect(wordPhrase(rel.cards[1201].fact)).toBe("same lines as #1202 and the draft #1208: src/theme.ts");
        expect(wordPhrase(rel.cards[1202].tag)).toBe("⇄ conflict with #1201 · src/theme.ts");
        expect(rel.cards[1206].role).toBeNull();
        const draft = rel.partners.find((p) => p.number === 1208);
        expect(wordPhrase(edgeLine(draft, "down"))).toBe("↓ the draft #1208, lower down · src/theme.ts");
        // Hovering the later PR of a pair lights the earlier one: a conflict is a relation, not "if merged now".
        const back = cardRelations(Shop, Listed, 1202);
        expect(back.partners.map((p) => p.number)).toEqual([1201]);
        expect(wordPhrase(back.cards[1201].tag)).toBe("⇄ conflict with #1202 · src/theme.ts");
    });

    it("says what changed after #1206 and #1201 merged, and strikes them through until the next read", () => {
        const queue = mergeQueue(Shop, Ready, Listed);
        const memory = queueMemory(queue, Shop, Listed);
        const left = Listed.filter((p) => p.number !== 1206 && p.number !== 1201);
        const answer: ReviewsAnswer = {
            dir: "/shop",
            state: "ok",
            ready: left.filter((p) => !p.draft),
            drafts: [Draft],
            merged: [
                { number: 1206, title: "Install guide", url: "", mergedat: "" } as never,
                { number: 1201, title: "Accent tokens", url: "", mergedat: "" } as never,
            ],
            githubat: 42,
        };
        const after = afterMergeOf(memory, answer, left);
        expect(after).toEqual({
            merged: [1206, 1201],
            needs: [{ number: 1202, after: 1201, paths: ["src/theme.ts"], pathcount: 1 }],
            read: 42,
        });
        expect(wordPhrase(afterMergeText(after))).toBe(
            "✓ #1206 and #1201 merged. #1202 touches the same lines as #1201: it now needs a rebase."
        );
        // The merge queue's own rebases are not handed over twice.
        expect(afterMergeOf(memory, answer, left, (n) => n === 1202).needs).toEqual([]);
        expect(wordPhrase(afterMergeText(afterMergeOf(memory, answer, left, (n) => n === 1202)))).toBe(
            "✓ #1206 and #1201 merged. No other pull request needs a rebase."
        );
        // Reported once: the forecast recomputes on the new base meanwhile.
        expect(afterMergeOf(forgetMerged(memory, after.merged), answer, left)).toBeNull();
        const struck = withMerged(
            mergeQueue(
                Shop,
                left.filter((p) => !p.draft),
                left
            ),
            after.merged
        );
        expect(struck.steps.slice(0, 2).map((s) => [s.number, s.merged])).toEqual([
            [1206, true],
            [1201, true],
        ]);
        expect(queueRanks(struck)[1206]).toBeUndefined();
        const joined = joinAfterMerge(after, { merged: [1203], needs: [], read: 43 });
        expect(joined.merged).toEqual([1206, 1201, 1203]);
        expect(joined.read).toBe(43);
    });

    it("reads in French", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        try {
            const queue = mergeQueue(Shop, Ready, Listed);
            expect(wordPhrase(queueCost(queue))).toBe("2 rebases au lieu de 3 dans l'ordre de la liste");
            const rel = cardRelations(Shop, Listed, null);
            expect(wordPhrase(queueWhy(queue, 1204, rel.byCard[1204]))).toBe("à rebaser après #1203 et #1205");
            expect(wordPhrase(rel.cards[1201].fact)).toBe(
                "mêmes lignes que #1202 et le brouillon #1208 : src/theme.ts"
            );
        } finally {
            I18nModel.getInstance().setLanguageSetting("en");
        }
    });
});
