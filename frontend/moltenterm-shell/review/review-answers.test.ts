// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    answerAtLine,
    answerKey,
    answerMarkerLines,
    answersOnSide,
    citedLine,
    groupAnswers,
    PrAnswersKey,
    worktreeFilePath,
} from "./review-answers";
import type { ReviewExplanation } from "./review-client";
import { answerHover } from "./review-diff-actions";

const Head = "a".repeat(40);
const Old = "b".repeat(40);

function answer(id: string, at: number, anchor?: ReviewExplanation["anchor"], extra?: Partial<ReviewExplanation>) {
    return { id, at, markdown: `answer ${id}`, anchor, headoid: Head, ...extra } as ReviewExplanation;
}

const lines = (startline: number, line: number, side: "LEFT" | "RIGHT" = "RIGHT", headoid = Head) => ({
    path: "pkg/a.go",
    side,
    startline: startline === line ? undefined : startline,
    line,
    headoid,
});

describe("answers on lines (FR-REV-006)", () => {
    it("groups a follow-up with the first answer on the same lines, latest activity first", () => {
        const groups = groupAnswers(
            [
                answer("e1", 10, lines(3, 5)),
                answer("e2", 20),
                answer("e3", 30, lines(3, 5)),
                answer("e4", 15, lines(3, 5, "LEFT")),
            ],
            Head
        );
        expect(groups.map((g) => g.key)).toEqual([
            answerKey(lines(3, 5)),
            PrAnswersKey,
            answerKey(lines(3, 5, "LEFT")),
        ]);
        expect(groups[0].answers.map((a) => a.id)).toEqual(["e1", "e3"]);
        expect(groups[1].anchor).toBeUndefined();
    });

    it("orders by an update too, and marks answers made on an earlier head", () => {
        const groups = groupAnswers(
            [answer("e1", 10, lines(1, 1, "RIGHT", Old), { updatedat: 50 }), answer("e2", 20, lines(8, 9))],
            Head
        );
        expect(groups[0].key).toBe(answerKey(lines(1, 1)));
        expect(groups[0].stale).toBe(true);
        expect(groups[1].stale).toBe(false);
    });

    it("shows markers on the head shown, on the answer's side, once per first line", () => {
        const all = [
            answer("e1", 1, lines(3, 5)),
            answer("e2", 2, lines(3, 4)),
            answer("e3", 3, lines(7, 7, "LEFT")),
            answer("e4", 4, lines(9, 9, "RIGHT", Old)),
            answer("e5", 5),
        ];
        const right = answersOnSide(all, "pkg/a.go", "RIGHT", Head, false);
        expect(right.map((a) => a.id)).toEqual(["e1", "e2"]);
        expect([...answerMarkerLines(right).keys()]).toEqual([3]);
        expect(answersOnSide(all, "pkg/a.go", "LEFT", Head, false).map((a) => a.id)).toEqual(["e3"]);
        expect(answersOnSide(all, "pkg/a.go", "LEFT", Head, true)).toEqual([]);
        expect(answersOnSide(all, "pkg/b.go", "RIGHT", Head, false)).toEqual([]);
        expect(answerAtLine(right, 3).id).toBe("e2");
        expect(answerAtLine(right, 5).id).toBe("e1");
        expect(answerAtLine(right, 6)).toBeNull();
    });

    it("hovers with the question, as text", () => {
        const hover = answerHover([answer("e1", 1, lines(3, 5), { question: "Pourquoi *ce* verrou ?" })]);
        expect(hover).toContain("lines 3–5");
        expect(hover).toContain("Pourquoi \\*ce\\* verrou ?");
    });

    it("reads the path:line an answer cites, and nothing else", () => {
        expect(citedLine("pkg/lock.go:12")).toEqual({ path: "pkg/lock.go", line: 12 });
        expect(citedLine("./main.go:3-5")).toEqual({ path: "main.go", line: 3 });
        expect(citedLine("ticket #585")).toBeNull();
        expect(citedLine(".kilocode/rules/rules.md")).toBeNull();
        expect(citedLine("commit 1a2b3c4: feat(#584): queue")).toBeNull();
        expect(citedLine("../x.go:1")).toBeNull();
        expect(citedLine("https://example.com/a.go:3")).toBeNull();
    });

    it("opens a cited file of the worktree, never outside it", () => {
        expect(worktreeFilePath("/w/review-7/", "./pkg/lock.go")).toBe("/w/review-7/pkg/lock.go");
        expect(worktreeFilePath("/w/review-7", "pkg/lock.go")).toBe("/w/review-7/pkg/lock.go");
        expect(worktreeFilePath("/w/review-7", "../etc/passwd")).toBeNull();
        expect(worktreeFilePath("/w/review-7", "/etc/passwd")).toBeNull();
        expect(worktreeFilePath("", "pkg/lock.go")).toBeNull();
    });
});
