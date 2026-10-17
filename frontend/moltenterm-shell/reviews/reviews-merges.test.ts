// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { beforeEach, describe, expect, it } from "vitest";
import { noteBatchMerges } from "./reviews-batch-client";
import type { BatchRun } from "./reviews-batch-model";
import type { ReviewMergedPr } from "./reviews-merged-model";
import { knownMerge, LocalMerges, mergeKey, ReviewsMerges, withLocalMerges } from "./reviews-merges";
import { navigableRows, nextRow, reviewCounts, ReviewPr, ReviewsAnswer, splitReviews } from "./reviews-model";

const Dir = "/p";
const Now = Date.UTC(2026, 9, 17, 12, 0);

function pr(number: number, extra?: Partial<ReviewPr>): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/o/r/pull/${number}`,
        branch: `fix/${number}-x`,
        base: "develop",
        createdat: "2026-10-16T10:00:00Z",
        updatedat: `2026-10-16T10:${String(number).padStart(2, "0")}:00Z`,
        merge: "clean",
        ci: { state: "success", success: 1, failure: 0, pending: 0, checks: [] },
        report: { state: "present" },
        unpublished: 0,
        ...extra,
    };
}

function merged(number: number, extra?: Partial<ReviewMergedPr>): ReviewMergedPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/o/r/pull/${number}`,
        branch: `fix/${number}-x`,
        base: "develop",
        mergedat: "2026-10-17T09:00:00Z",
        ...extra,
    };
}

function answer(extra?: Partial<ReviewsAnswer>): ReviewsAnswer {
    return {
        dir: Dir,
        state: "ok",
        repo: "o/r",
        target: "develop",
        ready: [pr(1), pr(2), pr(3)],
        drafts: [pr(4, { draft: true })],
        merged: [],
        githubat: Now - 60_000,
        ...extra,
    };
}

function numbers(prs: { number: number }[]): number[] {
    return prs.map((p) => p.number);
}

beforeEach(() => {
    ReviewsMerges.resetInstance();
});

describe("a merge MoltenTerm made leaves the list at once (#898)", () => {
    it("removes the PR from the list to review as soon as it is noted, and shows it in Recently merged", () => {
        const model = ReviewsMerges.getInstance();
        const a = answer();
        expect(withLocalMerges(a, globalStore.get(model.mergesAtom), Now)).toBe(a);
        model.note(Dir, { number: 2, title: "Fix two", mergedat: Now - 1000, oid: "abc", byyou: true });
        const shown = withLocalMerges(a, globalStore.get(model.mergesAtom), Now);
        expect(numbers(shown.ready)).toEqual([1, 3]);
        expect(numbers(shown.merged)).toEqual([2]);
        expect(shown.merged[0]).toMatchObject({ title: "Fix two", base: "develop", mergeoid: "abc" });
        expect(reviewCounts(shown).toreview + reviewCounts(shown).mergeable).toBe(2);
        expect(model.isMerged(Dir, 2)).toBe(true);
        expect(model.isMerged("/other", 2)).toBe(false);
    });

    it("drops a draft merged here too, and keeps one listed by GitHub in Recently merged once", () => {
        const merges: LocalMerges = {
            [mergeKey(Dir, 4)]: { number: 4, at: Now, byyou: true },
            [mergeKey(Dir, 3)]: { number: 3, at: Now, byyou: true },
        };
        const shown = withLocalMerges(answer({ merged: [merged(3)] }), merges, Now);
        expect(numbers(shown.ready)).toEqual([1, 2]);
        expect(numbers(shown.drafts)).toEqual([]);
        expect(numbers(shown.merged)).toEqual([4, 3]);
    });

    it("leaves other projects' answers alone", () => {
        const merges: LocalMerges = { [mergeKey("/q", 1)]: { number: 1, at: Now } };
        const a = answer();
        expect(withLocalMerges(a, merges, Now)).toBe(a);
    });

    it("does not bring an old batch merge back into Recently merged", () => {
        const old = Now - 30 * 24 * 60 * 60 * 1000;
        const merges: LocalMerges = { [mergeKey(Dir, 9)]: { number: 9, at: Now, mergedat: old, byyou: true } };
        const a = answer();
        expect(withLocalMerges(a, merges, Now)).toBe(a);
    });

    it("notes each PR a batch merged, and one it found merged away, as the run's event arrives", () => {
        const run = {
            id: "b1",
            dir: Dir,
            repo: "o/r",
            base: "develop",
            state: "running",
            current: 2,
            ciruns: 0,
            startedat: Now - 5000,
            items: [
                { number: 1, headref: "fix/1-x", headoid: "h1", state: "merged", endedat: Now - 2000 },
                { number: 2, headref: "fix/2-x", headoid: "h2", state: "skipped", reason: "mergedaway" },
                { number: 3, headref: "fix/3-x", headoid: "h3", state: "merging" },
            ],
        } as BatchRun;
        noteBatchMerges(run);
        const merges = globalStore.get(ReviewsMerges.getInstance().mergesAtom);
        expect(Object.keys(merges).sort()).toEqual([mergeKey(Dir, 1), mergeKey(Dir, 2)]);
        expect(merges[mergeKey(Dir, 1)]).toMatchObject({ byyou: true, mergedat: Now - 2000, base: "develop" });
        expect(merges[mergeKey(Dir, 2)].byyou).toBe(false);
        expect(numbers(withLocalMerges(answer(), merges, Now).ready)).toEqual([3]);
    });
});

describe("a PR merged elsewhere leaves the list on the next read (#898)", () => {
    it("drops a PR the read lists as merged, even when its open PRs came from an older cache", () => {
        const shown = withLocalMerges(answer({ merged: [merged(1, { mergedby: "octo" })] }), {}, Now);
        expect(numbers(shown.ready)).toEqual([2, 3]);
        expect(numbers(splitReviews(shown).ready)).toEqual([2, 3]);
    });
});

describe("navigation skips merged PRs (#898)", () => {
    it("walks from the PR before a merged one to the PR after it", () => {
        const merges: LocalMerges = { [mergeKey(Dir, 2)]: { number: 2, at: Now, byyou: true } };
        const rows = navigableRows(splitReviews(withLocalMerges(answer(), merges, Now)), true);
        expect(numbers(rows)).not.toContain(2);
        expect(nextRow(rows, 1, "ArrowDown")).toBe(3);
        expect(nextRow(rows, 3, "ArrowUp")).toBe(1);
    });
});

describe("knownMerge (#898)", () => {
    it("says who merged a PR the list lists, and that MoltenTerm merged one it noted", () => {
        const a = answer({ merged: [merged(5, { mergedby: "octo", mergeoid: "m5" })] });
        expect(knownMerge(a, {}, Dir, 5)).toMatchObject({
            by: "octo",
            oid: "m5",
            byyou: false,
            at: Date.parse("2026-10-17T09:00:00Z"),
        });
        const merges: LocalMerges = { [mergeKey(Dir, 6)]: { number: 6, at: Now, mergedat: Now - 10, byyou: true } };
        expect(knownMerge(a, merges, Dir, 6)).toMatchObject({ byyou: true, at: Now - 10 });
        expect(knownMerge(a, merges, Dir, 1)).toBeNull();
    });
});
