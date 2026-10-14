// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ReviewMergePlan, ReviewMergeRecord } from "./review-client";
import {
    canCancelMerge,
    canClickMerge,
    mergeButtonLabel,
    mergeDisabledReason,
    mergeRunning,
    mergeStateLabel,
    sheetRecord,
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
        const blocked = plan({ canmerge: false, reason: "2 failing: build, lint" });
        expect(canClickMerge(blocked, true, null)).toBe(false);
        expect(mergeDisabledReason(blocked, true, null)).toBe("2 failing: build, lint");
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
        expect(mergeStateLabel(record({ state: "updating" }), "develop")).toMatch(/rebasing the branch on develop/);
        expect(mergeStateLabel(record({ state: "refused", message: "New commits" }), "develop")).toBe("New commits");
    });

    it("lets the wait stop, never the merge call", () => {
        expect(canCancelMerge(record({ state: "waitingci" }))).toBe(true);
        expect(canCancelMerge(record({ state: "updating" }))).toBe(true);
        expect(canCancelMerge(record({ state: "merging" }))).toBe(false);
        expect(canCancelMerge(null)).toBe(false);
    });
});
