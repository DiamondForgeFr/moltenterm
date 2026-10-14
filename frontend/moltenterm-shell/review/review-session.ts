// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The review session (FR-REV-004, DS-REV-004): the developer's own Claude Code or Codex, started by wavesrv in a
// terminal of the Review tab, in the PR's worktree, read-only, with the molten-review MCP tools
// (pkg/molten/reviewsession). This module is the Review tab's entry point: start (or reattach) a PR's session on the
// first Ask the AI or when the AI panel opens, end it when the tab closes, follow its changes and the agent's posts.

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";

// must match pkg/molten/mcpreview/wire.go
export const ReviewSessionRoute = "molten:reviewsession";
export const ReviewSessionEvent = "molten:reviewsession";
export const ReviewStartCommand = "moltenreviewstart";
export const ReviewEndCommand = "moltenreviewend";
export const ReviewGetCommand = "moltenreviewget";
export const ReviewListCommand = "moltenreviewlist";
export const ReviewSelectionCommand = "moltenreviewselection";
export const ReviewPostsCommand = "moltenreviewposts";

// Starting may fetch the PR's branch and create its worktree.
const StartTimeoutMs = 100_000;
const CallTimeoutMs = 10_000;

export type ReviewAnchor = {
    path: string;
    side: "RIGHT" | "LEFT";
    startline?: number;
    line: number;
    headoid?: string;
    excerpt?: string;
};

export type ReviewStartRequest = {
    // The tab the session's terminal goes in; omitted, the calling window's tab.
    tabid?: string;
    projectdir: string;
    // owner/name
    repo: string;
    number: number;
    title?: string;
    headref: string;
    headoid?: string;
    baseref?: string;
    // claude or codex; omitted, the first installed.
    agent?: string;
};

export type ReviewSessionKey = { id?: string; repo?: string; number?: number };

export type ReviewSessionState = "starting" | "running" | "failed";

export type ReviewSessionInfo = {
    id: string;
    repo: string;
    number: number;
    title?: string;
    projectdir: string;
    headref: string;
    headoid: string;
    baseref?: string;
    worktree: string;
    worktreekind: "agent" | "review";
    agent: string;
    agentname: string;
    blockid: string;
    tabid?: string;
    command?: string;
    state: ReviewSessionState;
    message?: string;
    startedat: number;
    connected: boolean;
};

// noagent: no supported agent is installed; the review works without AI (FR-REV-004 AC6).
export type ReviewStartStatus = "started" | "attached" | "noagent" | "failed";

export type ReviewStartResult = { status: ReviewStartStatus; message?: string; session?: ReviewSessionInfo };

export type ReviewPost = {
    id: string;
    kind: "briefing" | "explanation" | "proposal" | "translation" | "keepnote";
    at: number;
    markdown?: string;
    text?: string;
    anchor?: ReviewAnchor;
    depth?: "quick" | "detailed";
    sources?: string[];
    related?: string[];
    principles?: string[];
    commentkind?: "comment" | "change";
    commentid?: string;
    explanationid?: string;
};

export type ReviewSessionUpdate = { session?: ReviewSessionInfo; ended?: boolean; post?: ReviewPost };

export function reviewScope(repo: string, num: number): string {
    return `review:${repo}#${num}`;
}

function call<T>(command: string, data: any, timeout = CallTimeoutMs): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: ReviewSessionRoute, timeout });
}

export function startReviewSession(req: ReviewStartRequest): Promise<ReviewStartResult> {
    return call(ReviewStartCommand, req, StartTimeoutMs);
}

export function endReviewSession(key: ReviewSessionKey): Promise<void> {
    return call(ReviewEndCommand, key);
}

export function getReviewSession(key: ReviewSessionKey): Promise<ReviewSessionInfo> {
    return call(ReviewGetCommand, key);
}

export async function listReviewSessions(): Promise<ReviewSessionInfo[]> {
    const rtn = await call<{ sessions: ReviewSessionInfo[] }>(ReviewListCommand, {});
    return rtn?.sessions ?? [];
}

// The developer's selection, which the agent reads with review_selection; no anchor and no text clears it.
export function setReviewSelection(key: ReviewSessionKey, anchor: ReviewAnchor, text?: string): Promise<void> {
    return call(ReviewSelectionCommand, { ...key, anchor, text });
}

export async function reviewSessionPosts(key: ReviewSessionKey): Promise<ReviewPost[]> {
    const rtn = await call<{ posts: ReviewPost[] }>(ReviewPostsCommand, key);
    return rtn?.posts ?? [];
}

// subscribeReviewSession follows one PR's session; returns the unsubscribe function.
export function subscribeReviewSession(
    repo: string,
    num: number,
    handler: (update: ReviewSessionUpdate) => void
): () => void {
    return waveEventSubscribeSingle({
        eventType: ReviewSessionEvent as WaveEventName,
        scope: reviewScope(repo, num),
        handler: (event) => handler(event.data as ReviewSessionUpdate),
    });
}
