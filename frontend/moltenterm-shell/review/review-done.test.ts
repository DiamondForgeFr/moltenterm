// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { TFunction } from "../i18n/i18n";
import { translate } from "../i18n/i18n-core";
import type { ReviewCleanupResult, ReviewCleanupStepResult } from "./review-cleanup";
import type { ReviewMergeRecord, ReviewPrStateResult } from "./review-client";
import {
    isReviewDone,
    isReviewMerged,
    mergedFooter,
    readReviewDoneMeta,
    reviewDoneDetail,
    reviewDoneLabel,
    reviewDoneMeta,
    reviewDoneOf,
    reviewDoneTabTitle,
    reviewMergedBanner,
    shouldReadPrState,
} from "./review-done";

const en: TFunction = (key, vars) => translate("en", key, vars);
const fr: TFunction = (key, vars) => translate("fr", key, vars);

const mergedOid = "abcdef0123456789abcdef0123456789abcdef01";
const mergedAt = Date.UTC(2026, 9, 15, 10, 30);

function record(over: Partial<ReviewMergeRecord>): ReviewMergeRecord {
    return { planid: "p1", method: "rebase", planhead: "h1", state: "merging", startedat: 1, ...over };
}

describe("review done state (#686)", () => {
    it("maps an open PR to open", () => {
        expect(reviewDoneOf(null, null, "develop")).toEqual({ kind: "open" });
        expect(reviewDoneOf(record({ state: "merging" }), { state: "open" }, "develop").kind).toBe("open");
        expect(reviewDoneOf(record({ state: "failed" }), null, "develop").kind).toBe("open");
        expect(isReviewDone(reviewDoneOf(null, { state: "open" }, "develop"))).toBe(false);
    });

    it("maps a merge from MoltenTerm to Validated, before GitHub's state", () => {
        const done = reviewDoneOf(
            record({ state: "merged", mergedoid: mergedOid, endedat: mergedAt }),
            { state: "merged", mergedoid: "other" },
            "develop"
        );
        expect(done).toEqual({ kind: "merged", base: "develop", oid: mergedOid, at: mergedAt, byyou: true });
        expect(reviewDoneLabel(en, done)).toBe("Validated");
        expect(reviewDoneLabel(fr, done)).toBe("Validée");
        const detail = reviewDoneDetail(en, done, "en");
        expect(detail).toContain("Merged into develop at abcdef0, ");
        expect(detail).toContain("Click to see the validation's result.");
    });

    it("maps a PR merged on GitHub, a merge refused as merged away included", () => {
        const github: ReviewPrStateResult = {
            state: "merged",
            baseref: "main",
            mergedoid: mergedOid,
            mergedat: "2026-10-15T10:30:00Z",
        };
        const done = reviewDoneOf(record({ state: "refused", refused: "mergedaway" }), github, "develop");
        expect(done).toEqual({ kind: "mergedgithub", base: "main", oid: mergedOid, at: mergedAt });
        expect(reviewDoneLabel(en, done)).toBe("Merged on GitHub");
        const detail = reviewDoneDetail(en, done, "en");
        expect(detail.startsWith("Merged into main at abcdef0, ")).toBe(true);
        expect(detail).not.toContain("Click");
    });

    it("maps a PR closed without merge to the neutral state", () => {
        const done = reviewDoneOf(null, { state: "closed", closedat: "2026-10-15T10:30:00Z" }, "develop");
        expect(done.kind).toBe("closed");
        expect(reviewDoneLabel(en, done)).toBe("Closed without merge");
        expect(reviewDoneDetail(en, done, "en").startsWith("Closed on GitHub without merge, ")).toBe(true);
        expect(reviewDoneDetail(en, { kind: "closed" }, "en")).toBe("Closed on GitHub without merge");
    });

    it("writes the detail without the pieces it lacks", () => {
        expect(reviewDoneDetail(en, { kind: "mergedgithub", base: "develop" }, "en")).toBe("Merged into develop");
        expect(reviewDoneDetail(en, { kind: "mergedgithub", base: "develop", oid: mergedOid }, "en")).toBe(
            "Merged into develop at abcdef0"
        );
        expect(reviewDoneDetail(en, { kind: "open" }, "en")).toBe("");
        expect(reviewDoneOf(null, { state: "merged", mergedat: "garbage" }, "develop").at).toBeUndefined();
    });

    it("gives the tab bar a meta for a finished PR only, and reads it back strictly", () => {
        expect(reviewDoneMeta({ kind: "open" })).toBeNull();
        expect(reviewDoneMeta({ kind: "merged" })).toEqual({ state: "merged" });
        expect(reviewDoneMeta({ kind: "mergedgithub" })).toEqual({ state: "merged" });
        expect(reviewDoneMeta({ kind: "closed" })).toEqual({ state: "closed" });
        expect(readReviewDoneMeta({ state: "merged", extra: 1 })).toEqual({ state: "merged" });
        expect(readReviewDoneMeta({ state: "open" })).toBeNull();
        expect(readReviewDoneMeta("merged")).toBeNull();
        expect(readReviewDoneMeta(null)).toBeNull();
    });

    it("names the tab's mark", () => {
        expect(reviewDoneTabTitle(en, { state: "merged" })).toBe("Merged: you can close this view");
        expect(reviewDoneTabTitle(en, { state: "closed" })).toBe("Closed without merge: you can close this view");
        expect(reviewDoneTabTitle(fr, { state: "merged" })).toBe("Fusionnée : vous pouvez fermer cette vue");
        expect(reviewDoneTabTitle(en, null)).toBe("");
    });

    it("proposes to close the tab in the Validate result once merged, saying where the cleanup is", () => {
        const cleanup = (steps: ReviewCleanupStepResult[]): ReviewCleanupResult => ({
            repo: "o/r",
            number: 7,
            steps,
            startedat: 2,
            endedat: 3,
        });
        const merged = record({ state: "merged" });
        for (const state of ["checking", "updating", "waitingci", "merging", "refused", "failed", "cancelled"]) {
            expect(mergedFooter(record({ state: state as ReviewMergeRecord["state"] }), null)).toBeNull();
        }
        expect(mergedFooter(null, null)).toBeNull();
        expect(mergedFooter(merged, null)).toBe("cleaning");
        expect(mergedFooter(record({ state: "merged", cleanuprunning: true }), cleanup([]))).toBe("cleaning");
        expect(
            mergedFooter(
                merged,
                cleanup([{ id: "review-worktree", state: "skipped", code: "kept" } as ReviewCleanupStepResult])
            )
        ).toBe("needs");
        expect(
            mergedFooter(merged, cleanup([{ id: "local-branch", state: "failed" } as ReviewCleanupStepResult]))
        ).toBe("failed");
        expect(mergedFooter(merged, cleanup([{ id: "local-branch", state: "done" } as ReviewCleanupStepResult]))).toBe(
            "done"
        );
        expect(en("review.done.footer.done")).toBe("Merged and cleaned up. This review view is no longer needed.");
        for (const footer of ["cleaning", "needs", "failed", "done"]) {
            expect(en(`review.done.footer.${footer}`)).not.toBe(`review.done.footer.${footer}`);
            expect(fr(`review.done.footer.${footer}`)).not.toBe(en(`review.done.footer.${footer}`));
        }
        expect(en("review.done.closeTab")).toBe("Close the review view");
        expect(en("review.done.keepOpen")).toBe("Keep it open");
    });

    it("knows a PR merged from what the Reviews list knows, before GitHub's state is read (#898)", () => {
        const known = { at: mergedAt, by: "octo", base: "develop", oid: mergedOid };
        const done = reviewDoneOf(null, null, "develop", known);
        expect(done).toMatchObject({ kind: "mergedgithub", by: "octo", at: mergedAt, oid: mergedOid });
        expect(isReviewDone(done)).toBe(true);
        expect(isReviewMerged(done)).toBe(true);
        expect(reviewDoneLabel(en, done)).toBe("Merged on GitHub");
        const batch = reviewDoneOf(null, { state: "merged" }, "develop", { byyou: true, at: mergedAt });
        expect(batch).toMatchObject({ kind: "mergedgithub", byyou: true, at: mergedAt });
        expect(reviewDoneLabel(en, batch)).toBe("Merged");
        expect(reviewDoneOf(null, null, "develop", null).kind).toBe("open");
        expect(isReviewMerged(reviewDoneOf(null, { state: "closed" }, "develop"))).toBe(false);
    });

    it("words the merged banner: by whom, when, into which branch (#898)", () => {
        const now = mergedAt + 60_000;
        const time = new Date(mergedAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" });
        const byYou = reviewDoneOf(
            { planid: "p", state: "merged", endedat: mergedAt } as ReviewMergeRecord,
            null,
            "develop"
        );
        expect(reviewMergedBanner(en, byYou, "en", now)).toBe(
            `Merged by you at ${time}, on develop. Nothing left to validate.`
        );
        const frTime = new Date(mergedAt).toLocaleTimeString("fr", { hour: "2-digit", minute: "2-digit" });
        expect(reviewMergedBanner(fr, byYou, "fr", now)).toBe(
            `Fusionnée par vous à ${frTime}, sur develop. Plus rien à valider.`
        );
        const elsewhere = reviewDoneOf(null, null, "develop", { by: "octo", at: mergedAt });
        expect(reviewMergedBanner(en, elsewhere, "en", mergedAt + 3 * 24 * 3600_000)).toMatch(
            /^Merged by octo on .+ at .+, on develop\. Nothing left to validate\.$/
        );
        expect(reviewMergedBanner(en, reviewDoneOf(null, null, "main", {}), "en", now)).toBe(
            "Merged, on main. Nothing left to validate."
        );
        expect(reviewMergedBanner(en, reviewDoneOf(null, { state: "closed" }, "develop"), "en", now)).toBe("");
    });

    it("asks GitHub once, then at most every recheck, never once merged", () => {
        expect(shouldReadPrState(null, null, 1000, 500)).toBe(true);
        expect(shouldReadPrState({ state: "open" }, 800, 1000, 500)).toBe(false);
        expect(shouldReadPrState({ state: "open" }, 400, 1000, 500)).toBe(true);
        expect(shouldReadPrState({ state: "closed" }, 400, 1000, 500)).toBe(true);
        expect(shouldReadPrState({ state: "merged" }, null, 1000, 500)).toBe(false);
    });
});
