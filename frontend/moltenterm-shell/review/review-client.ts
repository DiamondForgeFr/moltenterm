// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Review tab's side of wavesrv (FR-REV-002, DS-REV-002, DS-REV-007): the PR's file list and one file's two sides,
// computed by local git on commit ids (pkg/molten/review), the review store, and the tab itself. The frontend never
// runs git.

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { reviewScope } from "./review-session";

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
    ms: number;
};

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

// must match State in pkg/molten/review/store.go
export type ReviewState = {
    repo: string;
    number: number;
    viewed: Record<string, string>;
    lasthead?: string;
    since?: ReviewSince;
    rounds: ReviewRound[];
    updatedat?: number;
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

// subscribeReviewState follows a PR's review store (another window, the CLI); returns the unsubscribe function.
export function subscribeReviewState(repo: string, num: number, handler: (state: ReviewState) => void): () => void {
    return waveEventSubscribeSingle({
        eventType: ReviewUpdateEvent as WaveEventName,
        scope: reviewScope(repo, num),
        handler: (event) => handler(event.data as ReviewState),
    });
}
