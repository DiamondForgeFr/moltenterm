// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { branchSourceKey, branchSourceText, trunkRead } from "./branch-source";

// The header names the branch read and where its name came from (#2556).
describe("the branch a panel read", () => {
    it("names every source the collector sends", () => {
        for (const from of [
            ".molten/project.json branches",
            ".saasfoundry.json workflow.workingBranch",
            ".saasfoundry.json workflow.releaseBranch",
            ".saasfoundry.json mainBranch",
            "origin/HEAD",
            "git branch",
            "the branch checked out",
            "the default",
        ]) {
            expect(branchSourceKey(from), from).not.toBeNull();
            expect(branchSourceText(from), from).not.toMatch(/^mc\./);
        }
        expect(branchSourceText("something else")).toBe("");
    });

    it("says the trunk came from git when no manifest names it", () => {
        expect(trunkRead({ trunk: "development", trunkfrom: "origin/HEAD" })).toEqual({
            trunk: "development",
            from: "(the remote's default branch)",
            title: "Reads development: the remote's default branch",
        });
        expect(trunkRead({ trunk: "develop", trunkfrom: ".saasfoundry.json workflow.workingBranch" }).from).toBe(
            "(set by SaaSFoundry)"
        );
    });

    it("never leaves a dangling separator when git names no branch", () => {
        expect(trunkRead({ trunk: "", trunkfrom: "" }).trunk).toBe("no branch found");
        expect(trunkRead(null)).toBeNull();
    });
});
