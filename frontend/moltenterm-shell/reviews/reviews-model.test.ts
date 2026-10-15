// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    ciLabel,
    isReviewable,
    markReadyError,
    mergeLabel,
    navigableRows,
    nextRow,
    rebaseAskKey,
    rebaseAskShown,
    rebaseOutcome,
    reportLabel,
    reviewAriaLabel,
    reviewHeadline,
    ReviewPr,
    ReviewsAnswer,
    reviewsEmptyState,
    splitReviews,
    validateBlocked,
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
    it("words the merge states of FR-REV-001-AC2 and #683", () => {
        expect(mergeLabel("clean", "develop")).toMatchObject({ label: "ready to merge", tone: "success" });
        expect(mergeLabel("behind", "develop")).toMatchObject({
            label: "behind develop: GitHub updates it",
            tone: "neutral",
        });
        expect(mergeLabel("conflicts", "develop")).toMatchObject({ label: "conflicts with develop", tone: "pending" });
        expect(mergeLabel("blocked", "develop")).toMatchObject({ label: "blocked", tone: "failure" });
        expect(mergeLabel("unknown", "develop")).toMatchObject({ label: "checking…", tone: "neutral" });
    });

    it("says why a row's Validate cannot open the sheet (#683 AC1)", () => {
        const failing = { state: "failure" as const, success: 1, failure: 2, pending: 0, checks: [] };
        const running = { state: "pending" as const, success: 0, failure: 0, pending: 1, checks: [] };
        expect(validateBlocked(pr(1))).toBe("");
        expect(validateBlocked(pr(1, { merge: "behind" }))).toBe("");
        expect(validateBlocked(pr(1, { merge: "unknown", ci: running }))).toBe("");
        expect(validateBlocked(pr(1, { merge: "conflicts" }))).toBe("Conflicts with develop: ask for a rebase first.");
        expect(validateBlocked(pr(1, { merge: "blocked" }))).toContain("GitHub blocks the merge");
        expect(validateBlocked(pr(1, { ci: failing }))).toBe("Failing checks (2): fix them first.");
        expect(validateBlocked(pr(1, { draft: true, merge: "conflicts" }))).toContain("Draft");
    });

    it("keeps a rebase asked until the PR's head changes (#683 AC3)", () => {
        const ask = { name: "Jérôme", head: "aaa", at: 1 };
        expect(rebaseAskKey("/p", 4)).toBe("/p#4");
        expect(rebaseAskShown(ask, pr(4, { headoid: "aaa" }))).toBe(true);
        expect(rebaseAskShown(ask, pr(4, { headoid: "bbb" }))).toBe(false);
        expect(rebaseAskShown(null, pr(4, { headoid: "aaa" }))).toBe(false);
    });

    it("routes Ask for a rebase's answer (#683 AC2)", () => {
        expect(rebaseOutcome({ status: "sent", firstname: "Jérôme", agentname: "Codex" })).toMatchObject({
            kind: "asked",
            name: "Jérôme",
            text: "Rebase asked to Jérôme.",
        });
        expect(rebaseOutcome({ status: "started", agentname: "Claude Code" })).toMatchObject({
            kind: "asked",
            name: "Claude Code",
        });
        expect(rebaseOutcome({ status: "typed", firstname: "Rita" })).toMatchObject({ kind: "asked", note: true });
        expect(rebaseOutcome({ status: "offer", branch: "feature/4-x" })).toMatchObject({
            kind: "offer",
            text: "No agent works on feature/4-x. Start one with the rebase brief?",
        });
        expect(
            rebaseOutcome({
                status: "busy",
                reason: "agentbusy",
                agentstate: "working",
                firstname: "Rita",
                branch: "b",
            })
        ).toMatchObject({ kind: "info", text: "Rita is working on b: ask again once it is done." });
        expect(
            rebaseOutcome({ status: "busy", reason: "agentbusy", agentstate: "waiting", firstname: "Rita" }).text
        ).toContain("waiting for your answer");
        expect(rebaseOutcome({ status: "noagent", worktree: "/x/work-4", briefpath: "/d/b.md" }).text).toContain(
            "work-4"
        );
        expect(rebaseOutcome({ status: "failed", reason: "maincheckout", branch: "b" }).kind).toBe("failed");
        expect(rebaseOutcome(null, "boom")).toMatchObject({
            kind: "failed",
            text: "The rebase could not be asked: boom",
        });
        expect(rebaseOutcome(null)).toBeNull();
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
        expect(navigableRows(splitReviews(answer()), false).map((r) => r.number)).toEqual([1, 2]);
        const rows = navigableRows(splitReviews(answer()), true);
        expect(rows.map((r) => r.number)).toEqual([1, 2, 3]);
        expect(nextRow(rows, null, "ArrowDown")).toBe(1);
        expect(nextRow(rows, 1, "ArrowDown")).toBe(2);
        expect(nextRow(rows, 3, "ArrowDown")).toBe(3);
        expect(nextRow(rows, 2, "ArrowUp")).toBe(1);
        expect(nextRow(rows, 2, "End")).toBe(3);
        expect(nextRow(rows, 2, "Home")).toBe(1);
        expect(nextRow([], 2, "Home")).toBeNull();
    });

    it("splits drafts from the PRs waiting for review (#687 AC1)", () => {
        const split = splitReviews(answer());
        expect(split.ready.map((r) => r.number)).toEqual([1, 2]);
        expect(split.drafts.map((r) => r.number)).toEqual([3]);
        expect(splitReviews(null)).toEqual({ ready: [], drafts: [] });
        expect(splitReviews(answer({ ready: undefined, drafts: undefined }))).toEqual({ ready: [], drafts: [] });
    });

    it("moves a draft marked ready here until a newer GitHub read (#687 AC3)", () => {
        const a = answer({
            githubat: 1000,
            ready: [pr(1, { updatedat: "2026-10-12T10:00:00Z" }), pr(2, { updatedat: "2026-10-10T10:00:00Z" })],
            drafts: [pr(3, { draft: true, updatedat: "2026-10-11T10:00:00Z" }), pr(4, { draft: true })],
        });
        const moved = splitReviews(a, { [rebaseAskKey("/p", 3)]: 2000 });
        expect(moved.ready.map((r) => r.number)).toEqual([1, 3, 2]);
        expect(moved.ready.find((r) => r.number === 3).draft).toBe(false);
        expect(moved.drafts.map((r) => r.number)).toEqual([4]);
        // GitHub read after the click still says draft (converted back): GitHub wins.
        expect(
            splitReviews({ ...a, githubat: 3000 }, { [rebaseAskKey("/p", 3)]: 2000 }).drafts.map((r) => r.number)
        ).toEqual([3, 4]);
        // Another project's mark moves nothing.
        expect(splitReviews(a, { [rebaseAskKey("/q", 3)]: 2000 }).drafts.map((r) => r.number)).toEqual([3, 4]);
    });

    it("words Mark ready for review's failures in plain words (#687 AC4)", () => {
        expect(markReadyError({ status: "ready" })).toBe("");
        expect(markReadyError({ status: "failed", reason: "closed" })).toContain("closed");
        expect(markReadyError({ status: "failed", reason: "permission" })).toContain("cannot change");
        expect(markReadyError({ status: "failed", reason: "auth" })).toContain("gh auth login");
        expect(markReadyError({ status: "failed", reason: "notfound" })).toContain("does not know");
        expect(markReadyError({ status: "failed", reason: "nogh" })).toContain("not installed");
        expect(markReadyError({ status: "failed", reason: "error", message: "boom" })).toContain("boom");
        expect(markReadyError(null, "timeout")).toContain("timeout");
        expect(validateBlocked(pr(3, { draft: true }))).toBe("Draft: mark it ready for review first.");
    });

    it("offers Review in Mission Control on the PRs the view lists", () => {
        expect(isReviewable({ baseRefName: "develop" }, "develop")).toBe(true);
        expect(isReviewable({ baseRefName: "main" }, "develop")).toBe(false);
        expect(isReviewable({ baseRefName: "develop", isCrossRepository: true }, "develop")).toBe(false);
        expect(isReviewable({ baseRefName: "develop" }, "")).toBe(false);
    });
});
