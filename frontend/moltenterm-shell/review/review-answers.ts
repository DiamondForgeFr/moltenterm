// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The agent's answers to the developer's questions (FR-REV-006): cards of the AI panel grouped by the lines they are
// about (an anchor), so a follow-up on the same lines sits with the first answer, and markers in the diff's gutter on
// the head they were made on. An answer without an anchor is about the whole PR.

import type { ReviewExplanation } from "./review-client";
import type { FileLink } from "./review-model";
import type { ReviewSide } from "./review-selection";
import type { ReviewAnchor } from "./review-session";

// The group of the answers about the whole PR.
export const PrAnswersKey = "pr";

export type AnswerGroup = {
    key: string;
    anchor?: ReviewAnchor;
    // Oldest first, as the conversation went.
    answers: ReviewExplanation[];
    // The latest answer or update of the group.
    last: number;
    // stale: made on another head than the one shown.
    stale: boolean;
};

function startOf(anchor: ReviewAnchor): number {
    return anchor.startline ?? anchor.line;
}

// answerKey names the lines an answer is about: a follow-up on the same lines has the same key.
export function answerKey(anchor: ReviewAnchor): string {
    if (anchor == null) {
        return PrAnswersKey;
    }
    return `${anchor.side}:${startOf(anchor)}-${anchor.line}:${anchor.path}`;
}

function headOf(e: ReviewExplanation): string {
    return e.anchor?.headoid || e.headoid;
}

function lastOf(e: ReviewExplanation): number {
    return Math.max(e.at ?? 0, e.updatedat ?? 0);
}

// groupAnswers: the answers by their lines, the group with the latest activity first.
export function groupAnswers(explanations: readonly ReviewExplanation[], head: string): AnswerGroup[] {
    const groups = new Map<string, AnswerGroup>();
    for (const e of explanations ?? []) {
        const key = answerKey(e.anchor);
        let group = groups.get(key);
        if (group == null) {
            group = { key, anchor: e.anchor, answers: [], last: 0, stale: true };
            groups.set(key, group);
        }
        group.answers.push(e);
        group.last = Math.max(group.last, lastOf(e));
        if (head == null || headOf(e) == null || headOf(e) === head) {
            group.stale = false;
        }
    }
    const rtn = [...groups.values()];
    for (const g of rtn) {
        g.answers.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
        if (g.key === PrAnswersKey) {
            g.stale = false;
        }
    }
    return rtn.sort((a, b) => b.last - a.last);
}

// answersOnSide: the file's answers that show in the gutter of a side, on the head shown. In the "since" diff the left
// side is an earlier head, so base answers are only in the panel.
export function answersOnSide(
    explanations: readonly ReviewExplanation[],
    path: string,
    side: ReviewSide,
    head: string,
    since: boolean
): ReviewExplanation[] {
    if (path == null || (since && side === "LEFT")) {
        return [];
    }
    return (explanations ?? []).filter((e) => e.anchor?.path === path && e.anchor.side === side && headOf(e) === head);
}

// answerAtLine: the answer whose lines hold the line, the latest first.
export function answerAtLine(answers: readonly ReviewExplanation[], line: number): ReviewExplanation {
    for (let i = answers.length - 1; i >= 0; i--) {
        const a = answers[i].anchor;
        if (line >= startOf(a) && line <= a.line) {
            return answers[i];
        }
    }
    return null;
}

// answerMarkerLines: the answers by the first line of their lines, where their marker shows.
export function answerMarkerLines(answers: readonly ReviewExplanation[]): Map<number, ReviewExplanation[]> {
    const rtn = new Map<number, ReviewExplanation[]>();
    for (const e of answers) {
        const line = startOf(e.anchor);
        rtn.set(line, [...(rtn.get(line) ?? []), e]);
    }
    return rtn;
}

// citedLine reads a path:line or path:start-end an answer cites in its other uses or its sources (FR-REV-007 AC4);
// null for any other source (a ticket, a rule's name, a commit).
export function citedLine(text: string): FileLink {
    const m = /^(?:\.\/)?([^\s:]+):(\d+)(?:-\d+)?$/.exec((text ?? "").trim());
    if (m == null || m[1].split("/").includes("..") || Number(m[2]) <= 0) {
        return null;
    }
    return { path: m[1], line: Number(m[2]) };
}

// worktreeFilePath is the worktree's file an answer cites (FR-REV-007 AC4), or null when there is no worktree or the
// path would leave it.
export function worktreeFilePath(worktree: string, path: string): string {
    if (!worktree || !path) {
        return null;
    }
    const rel = path.replace(/^\.\//, "");
    if (rel.startsWith("/") || /^[a-z]:/i.test(rel) || rel.split(/[\\/]/).includes("..")) {
        return null;
    }
    return worktree.replace(/[\\/]+$/, "") + "/" + rel;
}
