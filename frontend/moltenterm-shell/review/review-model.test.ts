// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { repoOfPrUrl } from "../reviews/reviews-model";
import { ReviewFile, ReviewState } from "./review-client";
import {
    buildFileTree,
    collapsedReason,
    firstFile,
    isViewed,
    languageOf,
    newCommitsLabel,
    nextFile,
    sideBySideOf,
    treeFiles,
} from "./review-model";

function file(path: string, extra: Partial<ReviewFile> = {}): ReviewFile {
    return { path, status: "modified", additions: 1, deletions: 0, newblob: "b".repeat(40), ...extra };
}

describe("buildFileTree", () => {
    it("puts folders first, squashes single-folder chains and keeps files in tree order", () => {
        const files = [
            file("README.md"),
            file("pkg/molten/review/diff.go"),
            file("pkg/molten/review/store.go"),
            file("frontend/a.ts"),
            file("frontend/z/b.ts"),
        ];
        const tree = buildFileTree(files);
        expect(tree.map((n) => n.name)).toEqual(["frontend", "pkg/molten/review", "README.md"]);
        expect(tree[0].children.map((n) => n.name)).toEqual(["z", "a.ts"]);
        expect(treeFiles(tree).map((f) => f.path)).toEqual([
            "frontend/z/b.ts",
            "frontend/a.ts",
            "pkg/molten/review/diff.go",
            "pkg/molten/review/store.go",
            "README.md",
        ]);
    });

    it("handles an empty list", () => {
        expect(buildFileTree([])).toEqual([]);
        expect(firstFile([])).toBeNull();
    });
});

describe("files", () => {
    it("opens the first file that is not collapsed", () => {
        const files = [file("a.lock", { collapsed: "generated" }), file("b.go")];
        expect(firstFile(files).path).toBe("b.go");
        expect(firstFile([file("a.lock", { collapsed: "generated" })]).path).toBe("a.lock");
    });

    it("walks the files with the arrows, stopping at the ends", () => {
        const files = [file("a"), file("b"), file("c")];
        expect(nextFile(files, "a", 1).path).toBe("b");
        expect(nextFile(files, "c", 1).path).toBe("c");
        expect(nextFile(files, "a", -1).path).toBe("a");
        expect(nextFile(files, "missing", 1).path).toBe("a");
    });

    it("keeps a file viewed only while its head side is the one marked", () => {
        const state = { viewed: { "a.go": "b".repeat(40), "gone.txt": "" } } as unknown as ReviewState;
        expect(isViewed(state, file("a.go"))).toBe(true);
        expect(isViewed(state, file("a.go", { newblob: "c".repeat(40) }))).toBe(false);
        expect(isViewed(state, file("gone.txt", { status: "deleted", newblob: undefined }))).toBe(true);
        expect(isViewed(state, file("other.go"))).toBe(false);
        expect(isViewed(null, file("a.go"))).toBe(false);
    });

    it("says why a file is collapsed", () => {
        expect(collapsedReason("large", file("x", { newsize: 2 * 1024 * 1024 }))).toContain("2.0 MB");
        expect(collapsedReason("binary")).toContain("Binary");
        expect(collapsedReason("")).toBe("");
    });
});

describe("diff options", () => {
    it("defaults to the editor:inlinediff setting, the toggle overriding it", () => {
        expect(sideBySideOf(null, undefined)).toBe(true);
        expect(sideBySideOf(null, true)).toBe(false);
        expect(sideBySideOf(true, true)).toBe(true);
        expect(sideBySideOf(false, false)).toBe(false);
    });

    it("finds Monaco's language from the path", () => {
        expect(languageOf("pkg/a.go")).toBe("go");
        expect(languageOf("frontend/x.tsx")).toBe("typescript");
        expect(languageOf("Dockerfile")).toBe("dockerfile");
        expect(languageOf("LICENSE")).toBeUndefined();
    });

    it("words the new commits", () => {
        expect(newCommitsLabel(1, false)).toBe("1 new commit");
        expect(newCommitsLabel(3, false)).toBe("3 new commits");
        expect(newCommitsLabel(2, true)).toBe("2 new commits (rewritten)");
    });

    it("reads the repository of a PR's URL", () => {
        expect(repoOfPrUrl("https://github.com/DiamondForgeFr/moltenterm/pull/600")).toBe("DiamondForgeFr/moltenterm");
        expect(repoOfPrUrl("https://example.com/x")).toBe("");
        expect(repoOfPrUrl(undefined)).toBe("");
    });
});
