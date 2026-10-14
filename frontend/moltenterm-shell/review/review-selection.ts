// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Line selection in the Review tab's diff (FR-REV-003, DS-REV-003): the selected lines become an anchor in GitHub's
// review comment position (path, side, start line, line) on the head shown, with the lines' text as its excerpt. A
// selection inside one hunk of its side can carry a line comment; elsewhere Comment is a file-level comment quoting
// the lines, and Ask the AI works everywhere.

import { t } from "../i18n/i18n";
import {
    ReviewComment,
    ReviewCommentAction,
    ReviewCommentKind,
    ReviewCommentMessage,
    ReviewCommentState,
    ReviewHunk,
    ReviewState,
} from "./review-client";
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
            filereason: t("review.selection.reasonSince"),
        };
    }
    if (!inHunk(hunks, anchor.side as ReviewSide, start, anchor.line)) {
        return {
            anchor,
            text,
            linecomment: false,
            filereason: t("review.selection.reasonOutside"),
        };
    }
    return { anchor, text, linecomment: true };
}

export function sideLabel(side: string): string {
    return side === "LEFT" ? t("review.selection.base") : t("review.selection.head");
}

export function linesLabel(anchor: ReviewAnchor): string {
    if (anchor.startline != null && anchor.startline !== anchor.line) {
        return t("review.selection.lines", { start: anchor.startline, end: anchor.line });
    }
    return t("review.selection.line", { line: anchor.line });
}

// A label table read through keys at each access, so it follows a language switch.
function keyedLabels<K extends string>(prefix: string, keys: readonly K[]): Record<K, string> {
    const rtn = {} as Record<K, string>;
    for (const key of keys) {
        Object.defineProperty(rtn, key, { enumerable: true, get: () => t(`${prefix}.${key}`) });
    }
    return rtn;
}

// anchorLabel names a selection: file, side, lines.
export function anchorLabel(anchor: ReviewAnchor): string {
    return `${anchor.path} · ${sideLabel(anchor.side)} · ${linesLabel(anchor)}`;
}

export const CommentStateLabels: Record<ReviewCommentState, string> = keyedLabels<ReviewCommentState>(
    "review.comment.state",
    ["draft", "staged", "translated", "published", "dropped", "proposed"]
);

export const CommentKindLabels: Record<ReviewCommentKind, string> = keyedLabels<ReviewCommentKind>(
    "review.comment.kind",
    ["comment", "change"]
);

// What a comment's history entries say, by event (FR-REV-009 AC5).
export const CommentEventLabels: Record<string, string> = keyedLabels("review.comment.event", [
    "created",
    "proposed",
    "edited",
    "kind",
    "staged",
    "unstaged",
    "dropped",
    "restored",
    "accepted",
    "rewritten",
    "translated",
    "published",
]);

// commentActions: what the developer can do with a comment in its state (FR-REV-009 AC1, AC3). Published comments
// stay as they are; a proposal is accepted (it becomes staged) or dropped.
export function commentActions(comment: ReviewComment): ReviewCommentAction[] {
    switch (comment.state) {
        case "draft":
            return ["stage", "drop"];
        case "staged":
        case "translated":
            return ["unstage", "drop"];
        case "proposed":
            return ["accept", "drop"];
        case "dropped":
            return ["restore"];
    }
    return [];
}

// canEdit: the text and kind change until the comment is published or dropped.
export function canEdit(comment: ReviewComment): boolean {
    return comment.state !== "published" && comment.state !== "dropped";
}

// canDiscuss: the comments the developer can still send to the review session.
export function canDiscuss(comment: ReviewComment): boolean {
    return canEdit(comment);
}

// isStaged: the comments the next publication takes (FR-REV-010).
export function isStaged(comment: ReviewComment): boolean {
    return comment.state === "staged" || comment.state === "translated";
}

export function stagedCount(state: ReviewState): number {
    return (state?.comments ?? []).filter(isStaged).length;
}

export type CommentGroups = {
    proposals: ReviewComment[];
    staged: ReviewComment[];
    drafts: ReviewComment[];
    dropped: ReviewComment[];
};

// groupComments sorts the PR's open comments for the AI panel: the agent's proposals, the staged ones, the drafts, and
// the dropped ones (kept, restorable). Published comments belong to their round.
export function groupComments(state: ReviewState): CommentGroups {
    const rtn: CommentGroups = { proposals: [], staged: [], drafts: [], dropped: [] };
    const sorted = [...(state?.comments ?? [])].sort(
        (a, b) =>
            a.anchor.path.localeCompare(b.anchor.path) ||
            (a.anchor.startline ?? a.anchor.line) - (b.anchor.startline ?? b.anchor.line)
    );
    for (const c of sorted) {
        if (c.state === "proposed") {
            rtn.proposals.push(c);
        } else if (isStaged(c)) {
            rtn.staged.push(c);
        } else if (c.state === "draft") {
            rtn.drafts.push(c);
        } else if (c.state === "dropped") {
            rtn.dropped.push(c);
        }
    }
    return rtn;
}

// pendingRewrite: the latest rewrite the agent proposed that the developer has not used or ignored yet.
export function pendingRewrite(comment: ReviewComment): ReviewCommentMessage {
    const discussion = comment.discussion ?? [];
    for (let i = discussion.length - 1; i >= 0; i--) {
        if (discussion[i].rewritestate === "proposed") {
            return discussion[i];
        }
    }
    return null;
}

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
