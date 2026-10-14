// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ReviewComment, ReviewHunk, ReviewState } from "./review-client";
import { commentHover } from "./review-diff-actions";
import {
    anchorLabel,
    canDiscuss,
    canEdit,
    commentActions,
    commentAtLine,
    commentCounts,
    commentsOfFile,
    developerLanguage,
    groupComments,
    inHunk,
    isEmptySelection,
    makeAnchor,
    makeSelection,
    onEditorSide,
    pendingRewrite,
    selectedLines,
    stagedCount,
} from "./review-selection";

const Head = "a".repeat(40);

const Hunks: ReviewHunk[] = [
    { oldstart: 1, oldlines: 6, newstart: 1, newlines: 8 },
    { oldstart: 40, oldlines: 0, newstart: 42, newlines: 3 },
];

function comment(id: string, extra: Partial<ReviewComment> = {}): ReviewComment {
    return {
        id,
        anchor: { path: "a.ts", side: "RIGHT", line: 4, headoid: Head, excerpt: "x" },
        subject: "line",
        kind: "comment",
        state: "draft",
        original: { lang: "fr", text: "Pourquoi ?" },
        author: "developer",
        createdat: 1,
        ...extra,
    };
}

describe("anchors", () => {
    it("are GitHub's position: path, side, start line only for a range, line, head, excerpt", () => {
        expect(makeAnchor("a.ts", "RIGHT", 14, 10, Head, "t")).toEqual({
            path: "a.ts",
            side: "RIGHT",
            startline: 10,
            line: 14,
            headoid: Head,
            excerpt: "t",
        });
        expect(makeAnchor("a.ts", "LEFT", 3, 3, Head, "t").startline).toBeUndefined();
        expect(anchorLabel(makeAnchor("a.ts", "LEFT", 3, 5, Head, ""))).toBe("a.ts · base · lines 3–5");
        expect(anchorLabel(makeAnchor("a.ts", "RIGHT", 7, 7, Head, ""))).toBe("a.ts · head · line 7");
    });

    it("do not take the line a selection ends on at its first column", () => {
        expect(selectedLines({ startLineNumber: 3, startColumn: 4, endLineNumber: 6, endColumn: 1 })).toEqual([3, 5]);
        expect(selectedLines({ startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 1 })).toEqual([3, 3]);
        expect(isEmptySelection({ startLineNumber: 3, startColumn: 2, endLineNumber: 3, endColumn: 2 })).toBe(true);
        expect(isEmptySelection({ startLineNumber: 3, startColumn: 2, endLineNumber: 3, endColumn: 5 })).toBe(false);
    });
});

describe("hunks (AC4)", () => {
    it("take a line comment only inside one hunk of the selection's side", () => {
        expect(inHunk(Hunks, "RIGHT", 2, 8)).toBe(true);
        expect(inHunk(Hunks, "RIGHT", 8, 9)).toBe(false);
        expect(inHunk(Hunks, "RIGHT", 7, 43)).toBe(false);
        expect(inHunk(Hunks, "LEFT", 6, 6)).toBe(true);
        expect(inHunk(Hunks, "LEFT", 40, 40)).toBe(false);
    });

    it("make Comment file-level outside the hunks and in the since diff", () => {
        const inside = makeSelection(makeAnchor("a.ts", "RIGHT", 2, 3, Head, "x"), "x", Hunks, false);
        expect(inside.linecomment).toBe(true);
        const outside = makeSelection(makeAnchor("a.ts", "RIGHT", 20, 21, Head, "x"), "x", Hunks, false);
        expect(outside.linecomment).toBe(false);
        expect(outside.filereason).toMatch(/outside the diff's hunks/);
        const since = makeSelection(makeAnchor("a.ts", "RIGHT", 2, 3, Head, "x"), "x", Hunks, true);
        expect(since.linecomment).toBe(false);
        expect(since.filereason).toMatch(/All changes/);
    });
});

describe("comments", () => {
    const state = {
        comments: [
            comment("b", { anchor: { path: "a.ts", side: "RIGHT", startline: 10, line: 12, headoid: Head } }),
            comment("a"),
            comment("c", { state: "dropped" }),
            comment("d", { anchor: { path: "b.ts", side: "LEFT", line: 1, headoid: Head } }),
        ],
    } as ReviewState;

    it("list a file's comments in line order without the dropped ones, and count them per file", () => {
        expect(commentsOfFile(state, "a.ts").map((c) => c.id)).toEqual(["a", "b"]);
        expect([...commentCounts(state)]).toEqual([
            ["a.ts", 2],
            ["b.ts", 1],
        ]);
    });

    it("show in the gutter of their side on the head they were made on, never outdated", () => {
        const c = comment("x");
        expect(onEditorSide(c, "RIGHT", Head, false)).toBe(true);
        expect(onEditorSide(c, "LEFT", Head, false)).toBe(false);
        expect(onEditorSide(c, "RIGHT", "b".repeat(40), false)).toBe(false);
        expect(onEditorSide({ ...c, outdated: true }, "RIGHT", Head, false)).toBe(false);
        const base = comment("y", { anchor: { ...c.anchor, side: "LEFT" } });
        expect(onEditorSide(base, "LEFT", Head, true)).toBe(false);
    });

    it("are found by a line of their range", () => {
        const list = commentsOfFile(state, "a.ts");
        expect(commentAtLine(list, 11)?.id).toBe("b");
        expect(commentAtLine(list, 4)?.id).toBe("a");
        expect(commentAtLine(list, 5)).toBeNull();
    });

    it("hover with their state and an escaped text", () => {
        const hover = commentHover(comment("z", { original: { text: "use *this* [link](x)" }, state: "staged" }));
        expect(hover).toContain("**Staged comment** · line 4");
        expect(hover).toContain("use \\*this\\* \\[link\\]\\(x\\)");
    });

    it("are written in the app's language", () => {
        expect(developerLanguage("fr-FR")).toBe("fr");
        expect(developerLanguage("")).toBe("en");
    });

    it("hover a change request by its kind", () => {
        expect(commentHover(comment("k", { kind: "change" }))).toContain("**Draft change request**");
    });
});

// FR-REV-009: the developer's actions on a comment, the AI panel's groups and Publish review's count.
describe("review comment drafting", () => {
    it("offers the actions of each state", () => {
        expect(commentActions(comment("a"))).toEqual(["stage", "drop"]);
        expect(commentActions(comment("a", { state: "staged" }))).toEqual(["unstage", "drop"]);
        expect(commentActions(comment("a", { state: "translated" }))).toEqual(["unstage", "drop"]);
        expect(commentActions(comment("a", { state: "proposed", author: "agent" }))).toEqual(["accept", "drop"]);
        expect(commentActions(comment("a", { state: "dropped" }))).toEqual(["restore"]);
        expect(commentActions(comment("a", { state: "published" }))).toEqual([]);
        expect(canEdit(comment("a", { state: "proposed" }))).toBe(true);
        expect(canEdit(comment("a", { state: "dropped" }))).toBe(false);
        expect(canDiscuss(comment("a", { state: "published" }))).toBe(false);
    });

    it("groups the comments and counts the staged ones", () => {
        const state: ReviewState = {
            repo: "o/r",
            number: 1,
            viewed: {},
            rounds: [],
            comments: [
                comment("d", { anchor: { path: "b.ts", side: "RIGHT", line: 2 } }),
                comment("s", { state: "staged" }),
                comment("t", { state: "translated" }),
                comment("p", { state: "proposed", author: "agent" }),
                comment("x", { state: "dropped" }),
                comment("u", { state: "published" }),
            ],
        };
        const groups = groupComments(state);
        expect(groups.proposals.map((c) => c.id)).toEqual(["p"]);
        expect(groups.staged.map((c) => c.id)).toEqual(["s", "t"]);
        expect(groups.drafts.map((c) => c.id)).toEqual(["d"]);
        expect(groups.dropped.map((c) => c.id)).toEqual(["x"]);
        expect(stagedCount(state)).toBe(2);
        expect(stagedCount(null)).toBe(0);
    });

    it("finds the rewrite still waiting for the developer", () => {
        const c = comment("r", {
            discussion: [
                { id: "1", at: 1, by: "agent", text: "a", rewrite: "v1", rewritestate: "ignored" },
                { id: "2", at: 2, by: "developer", text: "?" },
                { id: "3", at: 3, by: "agent", text: "b", rewrite: "v2", rewritestate: "proposed" },
            ],
        });
        expect(pendingRewrite(c)?.id).toBe("3");
        expect(pendingRewrite(comment("n"))).toBeNull();
    });
});
