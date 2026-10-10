// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { gitProblem, sortFolderEntries } from "./git-problem";

describe("git problem (FR-SHELL-053-AC2)", () => {
    it("tells a folder outside any repository from a missing git and other failures", () => {
        expect(
            gitProblem("git rev-parse --git-dir: fatal: not a git repository (or any of the parent directories): .git")
        ).toBe("notrepo");
        expect(gitProblem("git is not installed (or not on the login shell's PATH)")).toBe("nogit");
        expect(gitProblem("git log: fatal: bad object HEAD")).toBe("other");
        expect(gitProblem(null)).toBe("other");
    });

    it("lists folders first, dot entries last", () => {
        const sorted = sortFolderEntries([
            { name: "b.txt", isDir: false },
            { name: ".env", isDir: false },
            { name: "src", isDir: true },
            { name: ".config", isDir: true },
            { name: "a.md", isDir: false },
        ]);
        expect(sorted.map((e) => e.name)).toEqual(["src", ".config", "a.md", "b.txt", ".env"]);
        expect(sortFolderEntries(null)).toEqual([]);
    });
});
