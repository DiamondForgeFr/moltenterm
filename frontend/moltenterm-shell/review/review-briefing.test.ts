// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { briefingNote, parseFileLink, reviewKey } from "./review-model";

describe("briefing links (FR-REV-005 AC1)", () => {
    it("reads the links that point into the PR", () => {
        expect(parseFileLink("pkg/a/b.go#L12")).toEqual({ path: "pkg/a/b.go", line: 12 });
        expect(parseFileLink("pkg/a/b.go#L12-L20")).toEqual({ path: "pkg/a/b.go", line: 12 });
        expect(parseFileLink("./frontend/x.tsx:40")).toEqual({ path: "frontend/x.tsx", line: 40 });
        expect(parseFileLink("frontend/x%20y.tsx")).toEqual({ path: "frontend/x y.tsx" });
        expect(parseFileLink("README.md")).toEqual({ path: "README.md" });
    });

    it("leaves web links, anchors and escapes alone", () => {
        expect(parseFileLink("https://github.com/o/r/pull/1")).toBeNull();
        expect(parseFileLink("mailto:a@b.c")).toBeNull();
        expect(parseFileLink("#what-changed")).toBeNull();
        expect(parseFileLink("../../etc/passwd")).toBeNull();
        expect(parseFileLink("")).toBeNull();
        expect(parseFileLink(undefined)).toBeNull();
    });
});

describe("briefing note (FR-REV-005 AC4)", () => {
    const at = 1_000_000;
    it("says when it was written", () => {
        expect(briefingNote({ at, headoid: "a".repeat(40) }, "a".repeat(40), at + 20_000)).toBe("just now");
        expect(briefingNote({ at }, "a".repeat(40), at + 5 * 60_000)).toBe("5 min ago");
        expect(briefingNote({ at }, null, at + 3 * 3_600_000)).toBe("3 h ago");
    });

    it("says when the PR moved since", () => {
        expect(briefingNote({ at, headoid: "b".repeat(40) }, "a".repeat(40), at + 60_000)).toBe(
            "1 min ago, on bbbbbbb: the PR moved since"
        );
    });

    it("names a PR case-insensitively", () => {
        expect(reviewKey("Owner/Repo", 7)).toBe(reviewKey("owner/repo", 7));
    });
});
