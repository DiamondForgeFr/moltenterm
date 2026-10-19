// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ReviewMergePlan, ReviewMergeRecord } from "./review-client";
import {
    canCancelMerge,
    canClickMerge,
    chosenMethod,
    mergeButtonLabel,
    mergeCleanup,
    mergeDisabledReason,
    mergeRunning,
    mergeWaitingText,
    sheetRecord,
    validateErrorText,
} from "./review-merge";

function plan(over: Partial<ReviewMergePlan> = {}): ReviewMergePlan {
    return {
        id: "p1",
        repo: "o/n",
        number: 7,
        dir: "/p",
        headref: "feature/7-x",
        baseref: "develop",
        headoid: "a".repeat(40),
        prstate: "OPEN",
        checks: [],
        steps: [],
        cleanup: [],
        canmerge: true,
        warnings: [],
        createdat: 1,
        ...over,
    };
}

function record(over: Partial<ReviewMergeRecord> = {}): ReviewMergeRecord {
    return { planid: "p1", method: "rebase", planhead: "a".repeat(40), state: "merging", startedat: 1, ...over };
}

describe("Validate's plan sheet", () => {
    it("enables Merge only on a clean plan with its warnings confirmed", () => {
        expect(canClickMerge(plan(), false, null)).toBe(true);
        expect(canClickMerge(null, false, null)).toBe(false);
        const blocked = plan({
            canmerge: false,
            blocking: "ci",
            checks: [{ id: "ci", state: "fail", code: "failing", count: 2, names: ["build", "lint"] }],
        });
        expect(canClickMerge(blocked, true, null)).toBe(false);
        expect(mergeDisabledReason(blocked, true, null)).toBe(
            "CI is green, local-* statuses included: 2 failing: build, lint"
        );
        const warned = plan({ warnings: ["comments"] });
        expect(canClickMerge(warned, false, null)).toBe(false);
        expect(mergeDisabledReason(warned, false, null)).toMatch(/Confirm the warnings/);
        expect(canClickMerge(warned, true, null)).toBe(true);
    });

    it("says Merge waits for the CI while it runs, and stays a failure otherwise (#925)", () => {
        const running = plan({
            canmerge: false,
            blocking: "ci",
            checks: [
                { id: "ci", state: "pending", code: "running", count: 2, names: ["build", "lint"] },
                { id: "blocked", state: "pending", code: "waitsci" },
            ],
        });
        expect(mergeWaitingText(running, null)).toBe(
            "Merge waits for the CI (2 still running: build, lint): re-check once it is green."
        );
        const computing = plan({
            canmerge: false,
            blocking: "conflict",
            checks: [{ id: "conflict", state: "pending", code: "computing" }],
        });
        expect(mergeWaitingText(computing, null)).toMatch(/^Merge waits: No conflict with the base: GitHub is still/);
        const rules = plan({
            canmerge: false,
            blocking: "blocked",
            checks: [{ id: "blocked", state: "fail", code: "blocked" }],
        });
        expect(mergeWaitingText(rules, null)).toBe("");
        expect(mergeDisabledReason(rules, false, null)).toMatch(/a required check or review is missing/);
        expect(mergeWaitingText(plan(), null)).toBe("");
    });

    it("never offers a second merge while one runs", () => {
        expect(canClickMerge(plan(), false, record({ state: "waitingci" }))).toBe(false);
        expect(canClickMerge(plan(), false, record({ state: "refused" }))).toBe(true);
        expect(mergeRunning(record({ state: "checking" }))).toBe(true);
        expect(mergeRunning(record({ state: "merged" }))).toBe(false);
    });

    it("shows the running merge, or the one this plan started", () => {
        expect(sheetRecord(record({ planid: "old", state: "merged" }), "p2")).toBeNull();
        expect(sheetRecord(record({ planid: "old", state: "updating" }), null)?.planid).toBe("old");
        expect(sheetRecord(record({ planid: "p2", state: "refused" }), "p2")?.state).toBe("refused");
        expect(sheetRecord(null, "p2")).toBeNull();
    });

    it("says what happens to a PR behind its base", () => {
        expect(mergeButtonLabel(plan({ behind: true }), "squash")).toBe("Update, then merge");
        expect(mergeButtonLabel(plan(), "rebase")).toBe("Rebase and merge");
    });

    // #673 AC2: the button names the method; a merge queue merges by itself.
    it("names the merge method", () => {
        expect(mergeButtonLabel(plan(), "squash")).toBe("Squash and merge");
        expect(mergeButtonLabel(plan(), "merge")).toBe("Merge");
        expect(mergeButtonLabel(plan({ queue: true, behind: true }), "squash")).toBe("Add to the merge queue");
    });

    // #673: the method picked holds while the plan allows it; else the plan's default; a plan from before #673 rebases.
    it("chooses the method the merge uses", () => {
        const all = plan({ methods: ["merge", "squash", "rebase"], method: "squash" });
        expect(chosenMethod(all, null)).toBe("squash");
        expect(chosenMethod(all, "rebase")).toBe("rebase");
        expect(chosenMethod(plan({ methods: ["merge"], method: "merge" }), "rebase")).toBe("merge");
        expect(chosenMethod(plan(), null)).toBe("rebase");
    });

    it("lets the wait stop, never the merge call", () => {
        expect(canCancelMerge(record({ state: "queued" }))).toBe(true);
        expect(mergeRunning(record({ state: "queued" }))).toBe(true);
        expect(canCancelMerge(record({ state: "waitingci" }))).toBe(true);
        expect(canCancelMerge(record({ state: "updating" }))).toBe(true);
        expect(canCancelMerge(record({ state: "merging" }))).toBe(false);
        expect(canCancelMerge(null)).toBe(false);
    });

    it("shows the cleanup this merge ran, never an older one", () => {
        const cleanup = { repo: "o/n", number: 7, steps: [], startedat: 5, endedat: 6 };
        expect(mergeCleanup(record({ state: "merged", startedat: 4 }), cleanup)).toBe(cleanup);
        expect(mergeCleanup(record({ state: "merged", startedat: 9 }), cleanup)).toBeNull();
        expect(mergeCleanup(record({ state: "refused", startedat: 4 }), cleanup)).toBeNull();
        expect(mergeCleanup(record({ state: "merged", startedat: 4 }), null)).toBeNull();
    });

    it("translates wavesrv's refusals and keeps gh's errors as they came", () => {
        expect(validateErrorText("molten-review-merge:stale")).toBe("This plan is no longer current: Validate again.");
        expect(validateErrorText("rpc error: molten-review-merge:confirm")).toBe(
            "Confirm the warnings to merge anyway."
        );
        expect(validateErrorText("gh: HTTP 502")).toBe("gh: HTTP 502");
    });
});
