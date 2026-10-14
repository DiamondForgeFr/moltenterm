// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Line selection in the Review tab's diff (FR-REV-003, DS-REV-003): the selected lines become an anchor in GitHub's
// review comment position (path, side, start line, line) on the head shown, with the lines' text as its excerpt. A
// selection inside one hunk of its side can carry a line comment; elsewhere Comment is a file-level comment quoting
// the lines, and Ask the AI works everywhere.

import { ReviewComment, ReviewCommentState, ReviewHunk, ReviewState } from "./review-client";
import { ReviewAnchor } from "./review-session";

export type ReviewSide = "LEFT" | "RIGHT";

// One selection of the diff: its anchor, its text, and whether it can take a line comment.
export type ReviewSelection = {
    anchor: ReviewAnchor;
    text: string;
    linecomment: boolean;
    // Why Comment is file-level, when it is.
    filereason?: string;
};

export function makeAnchor(
    path: string,
    side: ReviewSide,
    first: number,
    last: number,
    headoid: string,
    excerpt: string
): ReviewAnchor {
    const start = Math.min(first, last);
    const end = Math.max(first, last);
    const anchor: ReviewAnchor = { path, side, line: end, headoid, excerpt };
    if (start !== end) {
        anchor.startline = start;
    }
    return anchor;
}

// selectedLines is the range a Monaco selection covers: a selection ending at column 1 of a line does not take it.
export function selectedLines(sel: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
}): [number, number] {
    let end = sel.endLineNumber;
    if (end > sel.startLineNumber && sel.endColumn === 1) {
        end--;
    }
    return [sel.startLineNumber, end];
}

export function isEmptySelection(sel: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
}): boolean {
    return sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn;
}

// inHunk: the lines lie in one hunk of their side (GitHub refuses a line comment elsewhere, or across two hunks).
export function inHunk(hunks: readonly ReviewHunk[], side: ReviewSide, start: number, end: number): boolean {
    for (const h of hunks ?? []) {
        const first = side === "LEFT" ? h.oldstart : h.newstart;
        const count = side === "LEFT" ? h.oldlines : h.newlines;
        if (count > 0 && start >= first && end <= first + count - 1) {
            return true;
        }
    }
    return false;
}

// makeSelection builds a selection. since: the diff shows the changes since an earlier head, so its left side is not
// the PR's base and its hunks are not GitHub's: Comment is file-level there.
export function makeSelection(
    anchor: ReviewAnchor,
    text: string,
    hunks: readonly ReviewHunk[],
    since: boolean
): ReviewSelection {
    const start = anchor.startline ?? anchor.line;
    if (since) {
        return {
            anchor,
            text,
            linecomment: false,
            filereason: "Line comments are made on All changes: this one is file-level and quotes the lines.",
        };
    }
    if (!inHunk(hunks, anchor.side as ReviewSide, start, anchor.line)) {
        return {
            anchor,
            text,
            linecomment: false,
            filereason: "These lines are outside the diff's hunks: the comment is file-level and quotes them.",
        };
    }
    return { anchor, text, linecomment: true };
}

export function sideLabel(side: string): string {
    return side === "LEFT" ? "base" : "head";
}

export function linesLabel(anchor: ReviewAnchor): string {
    if (anchor.startline != null && anchor.startline !== anchor.line) {
        return `lines ${anchor.startline}–${anchor.line}`;
    }
    return `line ${anchor.line}`;
}

// anchorLabel names a selection: file, side, lines.
export function anchorLabel(anchor: ReviewAnchor): string {
    return `${anchor.path} · ${sideLabel(anchor.side)} · ${linesLabel(anchor)}`;
}

export const CommentStateLabels: Record<ReviewCommentState, string> = {
    draft: "Draft",
    staged: "Staged",
    translated: "Translated",
    published: "Published",
    dropped: "Dropped",
};

// commentsOfFile: the file's comments, in line order, without the dropped ones.
export function commentsOfFile(state: ReviewState, path: string): ReviewComment[] {
    return (state?.comments ?? [])
        .filter((c) => c.anchor?.path === path && c.state !== "dropped")
        .sort((a, b) => (a.anchor.startline ?? a.anchor.line) - (b.anchor.startline ?? b.anchor.line));
}

// commentCounts: the number of comments per file, for the file tree.
export function commentCounts(state: ReviewState): Map<string, number> {
    const rtn = new Map<string, number>();
    for (const c of state?.comments ?? []) {
        if (c.state === "dropped" || c.anchor?.path == null) {
            continue;
        }
        rtn.set(c.anchor.path, (rtn.get(c.anchor.path) ?? 0) + 1);
    }
    return rtn;
}

// onEditorSide: a comment shows in the gutter of its side when it was made on the head shown and is not outdated. In
// the "since" diff the left side is an earlier head, so base comments are only listed.
export function onEditorSide(comment: ReviewComment, side: ReviewSide, head: string, since: boolean): boolean {
    if (comment.outdated || comment.anchor.side !== side || comment.anchor.headoid !== head) {
        return false;
    }
    return !(since && side === "LEFT");
}

// commentAtLine: the comment whose range holds the line, the latest first.
export function commentAtLine(comments: readonly ReviewComment[], line: number): ReviewComment {
    for (let i = comments.length - 1; i >= 0; i--) {
        const a = comments[i].anchor;
        if (line >= (a.startline ?? a.line) && line <= a.line) {
            return comments[i];
        }
    }
    return null;
}

// developerLanguage is the language comments are written in: the app's locale ("fr-FR" is fr).
export function developerLanguage(locale: string): string {
    const lang = (locale ?? "").split(/[-_]/)[0].toLowerCase();
    return lang || "en";
}
