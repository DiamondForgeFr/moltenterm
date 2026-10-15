// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ReviewMergePlan, ReviewMergeRecord } from "./review-client";
import {
    canCancelMerge,
    canClickMerge,
    mergeButtonLabel,
    mergeCleanup,
    mergeDisabledReason,
    mergeRunning,
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
        expect(mergeButtonLabel(plan({ behind: true }))).toBe("Update, then merge");
        expect(mergeButtonLabel(plan())).toBe("Rebase and merge");
    });

    it("lets the wait stop, never the merge call", () => {
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
