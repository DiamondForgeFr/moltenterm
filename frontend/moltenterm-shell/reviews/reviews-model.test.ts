// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    ciLabel,
    isReviewable,
    mergeLabel,
    navigableRows,
    nextRow,
    reportLabel,
    reviewAriaLabel,
    reviewHeadline,
    ReviewPr,
    ReviewsAnswer,
    reviewsEmptyState,
} from "./reviews-model";

function pr(number: number, extra: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/a/b/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        createdat: "2026-10-10T10:00:00Z",
        updatedat: "2026-10-12T10:00:00Z",
        merge: "clean",
        ci: { state: "none", success: 0, failure: 0, pending: 0, checks: [] },
        report: { state: "unknown" },
        unpublished: 0,
        ...extra,
    };
}

function answer(extra: Partial<ReviewsAnswer> = {}): ReviewsAnswer {
    return {
        dir: "/p",
        state: "ok",
        target: "develop",
        ready: [pr(1), pr(2)],
        drafts: [pr(3, { draft: true })],
        ...extra,
    };
}

describe("reviews model", () => {
    it("words the merge states of FR-REV-001-AC2", () => {
        expect(mergeLabel("clean", "develop").label).toBe("clean");
        expect(mergeLabel("behind", "develop")).toMatchObject({ label: "behind: will be rebased", tone: "pending" });
        expect(mergeLabel("conflicts", "develop")).toMatchObject({ label: "conflicts", tone: "failure" });
        expect(mergeLabel("blocked", "develop")).toMatchObject({ label: "blocked", tone: "failure" });
        expect(mergeLabel("unknown", "develop").tone).toBe("neutral");
    });

    it("sums the checks, failing first", () => {
        const ci = {
            state: "failure" as const,
            success: 3,
            failure: 1,
            pending: 2,
            checks: [
                { name: "build", state: "failure" as const },
                { name: "local-ci", state: "success" as const, local: true },
            ],
        };
        expect(ciLabel(ci)).toMatchObject({ label: "CI 1 failing, 2 running, 3 passed", tone: "failure" });
        expect(ciLabel(ci).title).toContain("local-ci: success");
        expect(ciLabel(pr(1).ci)).toMatchObject({ label: "no checks", tone: "neutral" });
    });

    it("says where the test report is, or that it is missing", () => {
        expect(reportLabel({ state: "present", url: "u", where: "ticket" })).toMatchObject({
            label: "test report",
            tone: "success",
        });
        expect(reportLabel({ state: "present", where: "ticket" }).title).toContain("ticket");
        expect(reportLabel({ state: "missing" })).toMatchObject({ label: "no test report", tone: "pending" });
        expect(reportLabel({ state: "unknown" }).tone).toBe("neutral");
    });

    it("shows the ticket and its title first, else the PR's title", () => {
        expect(reviewHeadline(pr(5, { ticket: 579, tickettitle: "Reviews view" }))).toEqual({
            ticket: "#579",
            title: "Reviews view",
        });
        expect(reviewHeadline(pr(5, { ticket: 579 }))).toEqual({ ticket: "#579", title: "PR 5" });
        expect(reviewHeadline(pr(5))).toEqual({ ticket: "", title: "PR 5" });
        expect(reviewAriaLabel(pr(5, { ticket: 9, unpublished: 2 }))).toContain("2 unpublished comments");
    });

    it("explains the GitHub states of FR-REV-001-AC4", () => {
        expect(reviewsEmptyState(answer({ state: "nogh" })).title).toContain("not installed");
        expect(reviewsEmptyState(answer({ state: "loggedout" })).hint).toContain("gh auth login");
        expect(reviewsEmptyState(answer({ state: "norepo" })).title).toContain("no GitHub remote");
        expect(reviewsEmptyState(answer({ state: "error", message: "boom" })).details).toBe("boom");
        expect(reviewsEmptyState(answer())).toBeNull();
    });

    it("walks the ready rows, and the drafts once their group is open", () => {
        expect(navigableRows(answer(), false).map((r) => r.number)).toEqual([1, 2]);
        const rows = navigableRows(answer(), true);
        expect(rows.map((r) => r.number)).toEqual([1, 2, 3]);
        expect(nextRow(rows, null, "ArrowDown")).toBe(1);
        expect(nextRow(rows, 1, "ArrowDown")).toBe(2);
        expect(nextRow(rows, 3, "ArrowDown")).toBe(3);
        expect(nextRow(rows, 2, "ArrowUp")).toBe(1);
        expect(nextRow(rows, 2, "End")).toBe(3);
        expect(nextRow(rows, 2, "Home")).toBe(1);
        expect(nextRow([], 2, "Home")).toBeNull();
    });

    it("offers Review in Mission Control on the PRs the view lists", () => {
        expect(isReviewable({ baseRefName: "develop" }, "develop")).toBe(true);
        expect(isReviewable({ baseRefName: "main" }, "develop")).toBe(false);
        expect(isReviewable({ baseRefName: "develop", isCrossRepository: true }, "develop")).toBe(false);
        expect(isReviewable({ baseRefName: "develop" }, "")).toBe(false);
    });
});
