// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// #2562: a sync-back or release-candidate pull request merges with a merge commit; squash or rebase asks first, never
// refused; a repository without merge commits says so; a sync-back merged without one shows the repair.

import { describe, expect, it } from "vitest";
import { batchReasonText, batchReleaseNote } from "../reviews/reviews-batch-model";
import { ReviewMergePlan, ReviewMergeRecord } from "./review-client";
import {
    canClickMerge,
    mergeDisabledReason,
    mergeMethodNotes,
    needsConfirmation,
    overrideText,
    releaseConfirms,
    releaseMethodNote,
    releaseRepairText,
} from "./review-merge";

function plan(over: Partial<ReviewMergePlan> = {}): ReviewMergePlan {
    return {
        id: "p1",
        repo: "o/n",
        number: 9,
        dir: "/p",
        headref: "main",
        baseref: "develop",
        headoid: "a".repeat(40),
        prstate: "OPEN",
        methods: ["merge", "squash", "rebase"],
        method: "merge",
        release: "syncback",
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
    return {
        planid: "p1",
        method: "rebase",
        release: "syncback",
        planhead: "a".repeat(40),
        state: "merged",
        startedat: 1,
        ...over,
    };
}

describe("release pull requests in Validate", () => {
    it("merges with a merge commit without asking", () => {
        expect(releaseConfirms(plan(), "merge")).toBe(false);
        expect(releaseConfirms(plan(), null)).toBe(false);
        expect(canClickMerge(plan(), false, null, "merge")).toBe(true);
    });

    it("asks before a squash or a rebase, and never refuses it", () => {
        for (const method of ["squash", "rebase"] as const) {
            expect(releaseConfirms(plan(), method)).toBe(true);
            expect(needsConfirmation(plan(), method)).toBe(true);
            expect(canClickMerge(plan(), false, null, method)).toBe(false);
            expect(mergeDisabledReason(plan(), false, null, method)).toMatch(/Confirm the warnings/);
            expect(canClickMerge(plan(), true, null, method)).toBe(true);
        }
        expect(overrideText(plan(), "rebase")).toBe(
            "Merge this release pull request with rebase anyway: the release branch's history will not reach develop, and the branches will diverge."
        );
    });

    it("names both the release method and the plan's warnings", () => {
        const warned = plan({ warnings: ["comments"] });
        expect(overrideText(warned, "squash")).toContain("with squash anyway");
        expect(overrideText(warned, "squash")).toContain("Merge anyway: I have read the warnings above.");
        expect(overrideText(warned, "merge")).toBe("Merge anyway: I have read the warnings above.");
    });

    it("leaves other pull requests and merge queues as they were", () => {
        expect(releaseConfirms(plan({ release: undefined }), "rebase")).toBe(false);
        expect(canClickMerge(plan({ release: undefined }), false, null, "rebase")).toBe(true);
        expect(releaseConfirms(plan({ queue: true, method: "squash", methods: ["squash"] }), "squash")).toBe(false);
    });

    it("says its method is the release's, not the repository's default", () => {
        expect(mergeMethodNotes("merge", "merge", null, false, true)).toEqual({
            hint: "Release pull request: a merge commit, whatever the repository's default, which stays as it is",
            refused: "",
        });
    });

    it("points to molten release sync-back when the repository allows no merge commit", () => {
        const noMerge = plan({ methods: ["rebase"], method: "rebase" });
        expect(releaseMethodNote(noMerge)).toContain("does not allow merge commits");
        expect(releaseMethodNote(noMerge)).toContain("molten release sync-back");
        expect(releaseConfirms(noMerge)).toBe(true);
        expect(releaseMethodNote(plan())).toBe("");
        expect(releaseMethodNote(plan({ release: undefined, methods: ["rebase"] }))).toBe("");
    });

    it("shows the repair after a sync-back merged without a merge commit", () => {
        expect(releaseRepairText(record(), "develop")).toBe(
            "This sync-back was merged with rebase, not a merge commit: the release commit is not part of develop's history, and the branches have diverged. To repair it, open a new sync-back pull request (molten release sync-back) and merge it with a merge commit."
        );
        expect(releaseRepairText(record({ method: "merge" }), "develop")).toBe("");
        expect(releaseRepairText(record({ release: "rc" }), "main")).toBe("");
        expect(releaseRepairText(record({ state: "merging" }), "develop")).toBe("");
        expect(releaseRepairText(record({ release: undefined }), "develop")).toBe("");
    });
});

describe("release pull requests in the group merge", () => {
    it("says they merge with a merge commit", () => {
        expect(batchReleaseNote({ methods: ["merge", "rebase"], method: "rebase", releaseprs: [9, 12] })).toBe(
            "Release pull requests (#9, #12) merge with a merge commit, whatever the method above, so the release branch's history reaches the trunk."
        );
        expect(batchReleaseNote({ methods: ["rebase"], method: "rebase", releaseprs: [9] })).toContain(
            "molten release sync-back"
        );
        expect(batchReleaseNote({ methods: ["merge"], method: "merge" })).toBe("");
    });

    it("says why the group merge stopped at one", () => {
        const text = batchReasonText({ number: 9, reason: "warnings", names: ["releasemethod"] } as never, "develop");
        expect(text).toContain("would not reach develop");
    });
});
