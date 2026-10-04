// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { branchLabel, cleanResultLine } from "./branch-cleanup";

describe("branch cleaning (FR-MC-017)", () => {
    it("names remote branches with their remote, and reports the deletion", () => {
        expect(branchLabel({ name: "feature/1-x", remote: true, action: "delete" })).toBe("origin/feature/1-x");
        expect(branchLabel({ name: "feature/1-x", remote: false, action: "delete" })).toBe("feature/1-x");
        expect(cleanResultLine({ deleted: ["a", "origin/a"], failed: 0 })).toBe("2 branch(es) deleted.");
        expect(cleanResultLine({ deleted: ["a"], failed: 1 })).toBe("1 branch(es) deleted, 1 failed.");
    });
});
