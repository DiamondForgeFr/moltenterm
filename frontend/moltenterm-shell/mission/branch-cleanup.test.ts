// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { branchLabel, branchReason, cleanResultLine } from "./branch-cleanup";

describe("branch cleaning (FR-MC-017)", () => {
    it("names remote branches with their remote, and reports the deletion", () => {
        expect(branchLabel({ name: "feature/1-x", remote: true, action: "delete" })).toBe("origin/feature/1-x");
        expect(branchLabel({ name: "feature/1-x", remote: false, action: "delete" })).toBe("feature/1-x");
        expect(cleanResultLine({ deleted: ["a", "origin/a"], failed: 0 })).toBe("2 branch(es) deleted.");
        expect(cleanResultLine({ deleted: ["a"], failed: 1 })).toBe("1 branch(es) deleted, 1 failed.");
    });

    it("says why each branch goes or stays (#571)", () => {
        const b = (action: "delete" | "keep", reason: any, pr?: number) => ({
            name: "x",
            remote: true,
            action,
            reason,
            pr,
        });
        expect(branchReason(b("delete", "merged-pr", 61), "develop")).toBe("merged in #61");
        expect(branchReason(b("delete", "on-trunk"), "develop")).toBe("its code is on develop");
        expect(branchReason(b("delete", "patches-on-trunk"), "develop")).toBe(
            "its commits are on develop under new ids"
        );
        expect(branchReason(b("keep", "commits-after-pr", 7), "develop")).toBe("commits after #7 was merged");
        expect(branchReason(b("keep", "not-on-trunk"), "develop")).toBe("its code is not on the trunk yet");
        expect(branchReason(b("keep", "something-new"), "develop")).toBe("something-new");
    });
});
