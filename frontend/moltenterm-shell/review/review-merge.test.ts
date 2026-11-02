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
    mergeMethodNotes,
    mergeRunning,
    mergeWaitingText,
    overrideText,
    queuesOnClick,
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
            "CI is green, local-* statuses included: 2 failing: build, lint. GitHub requires them and refuses the merge while they fail."
        );
        const warned = plan({ warnings: ["comments"] });
        expect(canClickMerge(warned, false, null)).toBe(false);
        expect(mergeDisabledReason(warned, false, null)).toMatch(/Confirm the warnings/);
        expect(canClickMerge(warned, true, null)).toBe(true);
    });

    it("asks to confirm red checks GitHub does not require, and only those (#943)", () => {
        const red = plan({
            warnings: ["ci"],
            checks: [{ id: "ci", state: "warn", code: "failingoptional", count: 1, names: ["sync-review"] }],
        });
        expect(canClickMerge(red, false, null)).toBe(false);
        expect(mergeDisabledReason(red, false, null)).toMatch(/Confirm the warnings/);
        expect(overrideText(red)).toBe(
            "Validate anyway: I have seen the red checks (sync-review) and the warnings above."
        );
        expect(canClickMerge(red, true, null)).toBe(true);
        expect(mergeDisabledReason(red, true, null)).toBe("");

        const green = plan({ checks: [{ id: "ci", state: "ok", code: "passed", count: 3 }] });
        expect(canClickMerge(green, false, null)).toBe(true);
        expect(overrideText(plan({ warnings: ["comments"] }))).toBe("Merge anyway: I have read the warnings above.");

        const required = plan({
            canmerge: false,
            blocking: "ci",
            checks: [{ id: "ci", state: "fail", code: "failing", count: 1, names: ["build"] }],
        });
        expect(canClickMerge(required, true, null)).toBe(false);
        expect(mergeDisabledReason(required, true, null)).toContain("GitHub requires them");
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

    // FR-REV-026 AC1, AC10: checks running and none failing, Validate puts the PR in the merge queue, unless the
    // setting keeps it blocked.
    it("validates while CI runs, or names the setting that keeps it blocked", () => {
        const running = { id: "ci", state: "pending" as const, code: "running", count: 2, names: ["build", "lint"] };
        const queueable = plan({ canmerge: false, canqueue: true, blocking: "ci", checks: [running] });
        expect(queuesOnClick(queueable)).toBe(true);
        expect(canClickMerge(queueable, false, null)).toBe(true);
        expect(mergeButtonLabel(queueable, "rebase")).toBe("Validate — merges when CI is green");
        expect(queuesOnClick(plan())).toBe(false);
        expect(canClickMerge({ ...queueable, warnings: ["comments"] }, false, null)).toBe(false);
        const greenOnly = plan({ canmerge: false, greenonly: true, blocking: "ci", checks: [running] });
        expect(canClickMerge(greenOnly, false, null)).toBe(false);
        expect(mergeDisabledReason(greenOnly, false, null)).toContain("Validate only once CI is green");
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

    // #957: the sheet says the method is the repository's default, or becomes it, and names a refused remembered one.
    it("says what the method choice does for the repository", () => {
        expect(mergeMethodNotes("rebase", "rebase", null, false)).toEqual({
            hint: "Default for this repository",
            refused: "",
        });
        expect(mergeMethodNotes("rebase", "merge", null, false).hint).toBe("Becomes the default for this repository");
        expect(mergeMethodNotes("merge", "merge", "rebase", false)).toEqual({
            hint: "Default for this repository",
            refused: "Rebase is no longer allowed here: Merge commit instead.",
        });
        expect(mergeMethodNotes("squash", "squash", "rebase", true).hint).toBe(
            "Set by the merge queue of this repository"
        );
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
