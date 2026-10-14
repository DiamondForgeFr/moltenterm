// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Review tab's side of wavesrv (FR-REV-002, DS-REV-002, DS-REV-007): the PR's file list and one file's two sides,
// computed by local git on commit ids (pkg/molten/review), the review store, and the tab itself. The frontend never
// runs git.

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { ReviewCleanupResult } from "./review-cleanup";
import { ReviewAnchor, reviewScope } from "./review-session";

// must match pkg/molten/review/route.go
export const ReviewRoute = "molten:review";
export const ReviewUpdateEvent = "molten:review:update";
const OpenCommand = "moltenreviewopen";
const FilesCommand = "moltenreviewfiles";
const FileCommand = "moltenreviewfile";
const CompareCommand = "moltenreviewcompare";
const WorktreeCommand = "moltenreviewworktree";
const StateCommand = "moltenreviewstate";
const ViewedCommand = "moltenreviewviewed";
const ShownCommand = "moltenreviewshown";
const MergePlanCommand = "moltenreviewmergeplan";
const MergeCommand = "moltenreviewmerge";
const MergeCancelCommand = "moltenreviewmergecancel";
const AiPaneCommand = "moltenreviewaipane";
const CommentCommand = "moltenreviewcomment";
const UncommentCommand = "moltenreviewcommentdelete";
const RelocateCommand = "moltenreviewrelocate";

// A file list or a compare may fetch the PR's branches; a worktree may be created.
const GitTimeoutMs = 95_000;
const CallTimeoutMs = 15_000;

// must match pkg/molten/review/diff.go
export type ReviewFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechanged" | "submodule";
export type ReviewCollapsed = "" | "binary" | "generated" | "large" | "submodule";

export type ReviewFile = {
    path: string;
    oldpath?: string;
    status: ReviewFileStatus;
    additions: number;
    deletions: number;
    binary?: boolean;
    generated?: boolean;
    oldblob?: string;
    newblob?: string;
    oldsize?: number;
    newsize?: number;
    collapsed?: ReviewCollapsed;
};

export type ReviewFilesRequest = {
    dir: string;
    headref: string;
    baseref: string;
    headoid?: string;
    baseoid?: string;
    from?: string;
};

export type ReviewFilesResult = {
    headoid: string;
    baseoid: string;
    from?: string;
    files: ReviewFile[];
    ms: number;
    cached?: boolean;
};

export type ReviewFileResult = {
    path: string;
    original: string;
    modified: string;
    collapsed?: ReviewCollapsed;
    oldlines?: number;
    newlines?: number;
    binary?: boolean;
    // The hunks of the diff GitHub shows: a line comment goes inside one (FR-REV-003).
    hunks?: ReviewHunk[];
    ms: number;
};

export type ReviewHunk = { oldstart: number; oldlines: number; newstart: number; newlines: number };

export type ReviewCompareResult = { commits: number; rewritten?: boolean };

export type ReviewWorktree = { worktree: string; kind: "agent" | "review"; ms: number };

export type ReviewRound = {
    id: string;
    startedat: number;
    headoid: string;
    publishedat?: number;
    githubreviewid?: number;
    githuburl?: string;
    restartedat?: number;
};

export type ReviewSince = { from: string; to: string; published?: boolean };

// must match pkg/molten/review/merge.go and postmerge.go
export type ReviewCheckState = "ok" | "info" | "warn" | "pending" | "fail";
export type ReviewMergeCheck = { id: string; label: string; state: ReviewCheckState; detail?: string };
export type ReviewMergeStep = { id: string; label: string; detail?: string };
export type ReviewCleanupStep = {
    id: string;
    label: string;
    state: "planned" | "done" | "skipped" | "failed";
    detail?: string;
};

export type ReviewMergePlan = {
    id: string;
    repo: string;
    number: number;
    dir: string;
    title?: string;
    url?: string;
    ticket?: number;
    headref: string;
    baseref: string;
    headoid: string;
    prstate: string;
    mergestate?: string;
    mergeable?: string;
    behind?: boolean;
    checks: ReviewMergeCheck[];
    steps: ReviewMergeStep[];
    cleanup: ReviewCleanupStep[];
    canmerge: boolean;
    reason?: string;
    warnings: string[];
    createdat: number;
};

export type ReviewMergeState =
    | "checking"
    | "updating"
    | "waitingci"
    | "merging"
    | "merged"
    | "refused"
    | "failed"
    | "cancelled";

export type ReviewMergeRecord = {
    planid: string;
    method: string;
    planhead: string;
    head?: string;
    mergedoid?: string;
    state: ReviewMergeState;
    refused?: "headmoved" | "basemoved" | "check" | "mergedaway";
    message?: string;
    updated?: boolean;
    overridden?: string[];
    startedat: number;
    endedat?: number;
    cleanup?: ReviewCleanupStep[];
    cleanuprunning?: boolean;
};
// The review session's latest briefing (FR-REV-005); headoid: the head the agent briefed.
export type ReviewBriefing = { markdown: string; headoid?: string; agent?: string; at: number };

// must match State in pkg/molten/review/store.go
export type ReviewState = {
    repo: string;
    number: number;
    briefing?: ReviewBriefing;
    viewed: Record<string, string>;
    lasthead?: string;
    since?: ReviewSince;
    rounds: ReviewRound[];
    // What the last cleanup after the merge did (FR-REV-013, review-cleanup.ts).
    cleanup?: ReviewCleanupResult;
    comments?: ReviewComment[];
    updatedat?: number;
    merge?: ReviewMergeRecord;
};

// The PR a Review tab shows, kept in its block's meta (PrMetaKey).
export type ReviewPrInfo = {
    dir: string;
    repo: string;
    number: number;
    title?: string;
    url?: string;
    headref: string;
    baseref: string;
    headoid?: string;
    baseoid?: string;
    ticket?: number;
};

export const ReviewPrMetaKey = "molten:review";

function call<T>(command: string, data: any, timeout = CallTimeoutMs): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: ReviewRoute, timeout });
}

export function openReviewTab(workspaceid: string, pr: ReviewPrInfo): Promise<{ tabid: string; created?: boolean }> {
    return call(OpenCommand, { workspaceid, pr });
}

// openReviewAiPane returns the PR's AI panel in the tab, creating it right of the review block (DS-REV-012).
export function openReviewAiPane(
    tabid: string,
    blockid: string,
    pr: ReviewPrInfo
): Promise<{ blockid: string; created?: boolean }> {
    return call(AiPaneCommand, { tabid, blockid, pr });
}

export function reviewFiles(req: ReviewFilesRequest): Promise<ReviewFilesResult> {
    return call(FilesCommand, req, GitTimeoutMs);
}

export function reviewFile(req: {
    dir: string;
    path: string;
    oldblob?: string;
    newblob?: string;
    load?: boolean;
}): Promise<ReviewFileResult> {
    return call(FileCommand, req, GitTimeoutMs);
}

export function reviewCompare(req: {
    dir: string;
    headref: string;
    from: string;
    to: string;
}): Promise<ReviewCompareResult> {
    return call(CompareCommand, req, GitTimeoutMs);
}

export function reviewWorktree(req: {
    dir: string;
    number: number;
    headref: string;
    headoid: string;
}): Promise<ReviewWorktree> {
    return call(WorktreeCommand, req, GitTimeoutMs);
}

export function reviewState(repo: string, num: number): Promise<ReviewState> {
    return call(StateCommand, { repo, number: num });
}

export function setReviewViewed(
    repo: string,
    num: number,
    path: string,
    blob: string,
    viewed: boolean
): Promise<ReviewState> {
    return call(ViewedCommand, { repo, number: num, path, blob: blob || undefined, viewed });
}

export function setReviewShown(repo: string, num: number, headoid: string): Promise<ReviewState> {
    return call(ShownCommand, { repo, number: num, headoid });
}

// Validate (FR-REV-012): the plan reads the PR once on GitHub; the merge starts on the developer's click and reports
// through the review store.
export function reviewMergePlan(req: {
    dir: string;
    repo: string;
    number: number;
    ticket?: number;
}): Promise<ReviewMergePlan> {
    return call(MergePlanCommand, req, GitTimeoutMs);
}

export function reviewMerge(repo: string, num: number, planid: string, override: boolean): Promise<ReviewMergeRecord> {
    return call(MergeCommand, { repo, number: num, planid, override: override || undefined });
}

export function reviewMergeCancel(repo: string, num: number): Promise<void> {
    return call(MergeCancelCommand, { repo, number: num });
}

// must match pkg/molten/review/comments.go
export type ReviewCommentSubject = "line" | "file";
export type ReviewCommentState = "draft" | "staged" | "translated" | "published" | "dropped";
export type ReviewCommentText = { lang?: string; text: string };

export type ReviewComment = {
    id: string;
    round?: string;
    anchor: ReviewAnchor;
    // line: a GitHub line comment on the anchor; file: a file-level comment quoting the anchor's excerpt.
    subject: ReviewCommentSubject;
    kind: "comment" | "change";
    state: ReviewCommentState;
    original: ReviewCommentText;
    translation?: ReviewCommentText;
    githubcommentid?: number;
    author: string;
    // The lines are not in the head shown any more; the comment keeps its excerpt.
    outdated?: boolean;
    createdat: number;
    updatedat?: number;
};

export type ReviewCommentRequest = {
    // Set: changes that comment's text; otherwise a new draft on the anchor.
    id?: string;
    anchor?: ReviewAnchor;
    subject?: ReviewCommentSubject;
    kind?: "comment" | "change";
    text: string;
    lang?: string;
};

export function saveReviewComment(repo: string, num: number, req: ReviewCommentRequest): Promise<ReviewState> {
    return call(CommentCommand, { repo, number: num, ...req });
}

export function deleteReviewComment(repo: string, num: number, id: string): Promise<ReviewState> {
    return call(UncommentCommand, { repo, number: num, id });
}

// relocateReviewComments moves the comments made on other heads to the head shown, or marks them outdated.
export function relocateReviewComments(req: {
    repo: string;
    number: number;
    dir: string;
    headoid: string;
    baseoid: string;
}): Promise<ReviewState> {
    return call(RelocateCommand, req, GitTimeoutMs);
}

// subscribeReviewState follows a PR's review store (another window, the CLI); returns the unsubscribe function.
export function subscribeReviewState(repo: string, num: number, handler: (state: ReviewState) => void): () => void {
    return waveEventSubscribeSingle({
        eventType: ReviewUpdateEvent as WaveEventName,
        scope: reviewScope(repo, num),
        handler: (event) => handler(event.data as ReviewState),
    });
}
