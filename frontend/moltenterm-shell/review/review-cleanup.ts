// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The cleanup after a merge (FR-REV-013, DS-REV-010), run by wavesrv (pkg/molten/review/cleanup.go): Validate calls it
// right after its merge, and it also runs on its own for a PR merged earlier. Each step comes back done, skipped or
// failed with a code and its data, which the Validate sheet writes in the interface's language (review-stepper.ts).
// The cleanup is complete by default (#672): a worktree is kept only when removing it would lose work, and then comes
// back with what it would lose and the risk to confirm.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { ReviewRoute } from "./review-client";

// must match pkg/molten/review/cleanup.go
const CleanupCommand = "moltenreviewcleanup";
// wavesrv gives the cleanup five minutes; the answer is awaited a little longer.
const CleanupTimeoutMs = 310_000;

export type ReviewCleanupStepId =
    | "pr"
    | "ticket-close"
    | "ticket-done"
    | "review-worktree"
    | "agent-worktree"
    | "local-branch"
    | "remote-branch"
    | "other-prs";

export type ReviewCleanupState = "done" | "skipped" | "failed";
// planned: a step of Validate's plan sheet, before the merge (pkg/molten/review/postmerge.go).
export type ReviewCleanupStepState = "planned" | ReviewCleanupState;

export const ReviewCleanupSteps: ReviewCleanupStepId[] = [
    "pr",
    "ticket-close",
    "ticket-done",
    "review-worktree",
    "agent-worktree",
    "local-branch",
    "remote-branch",
    "other-prs",
];

// must match WorktreeRisk in pkg/molten/mission/worktree.go
export type ReviewWorktreeRisk = { sha: string; changecount: number; unpushed: number; ignoredfilecount: number };

// must match WorktreeLoss in pkg/molten/review/loss.go; commitcount -1: git could not tell.
export type ReviewWorktreeLoss = {
    changes: string[];
    changecount: number;
    commits: { sha: string; subject: string }[];
    commitcount: number;
    ignored: string[];
    ignoredcount: number;
};

export type ReviewCleanupPr = {
    number: number;
    branch: string;
    url?: string;
    state: ReviewCleanupState;
    flag?: "agent-busy" | "needs-rebase";
    error?: string;
};

export type ReviewCleanupStepResult = {
    id: ReviewCleanupStepId;
    state: ReviewCleanupStepState;
    code?: string;
    error?: string;
    ticket?: number;
    branch?: string;
    base?: string;
    path?: string;
    loss?: ReviewWorktreeLoss;
    // The kept agent worktree's risk, sent back to remove it and lose its work.
    confirm?: ReviewWorktreeRisk;
    prs?: ReviewCleanupPr[];
    updated?: number;
    flagged?: number;
    failed?: number;
    // The English text of results made before #672.
    reason?: string;
    message?: string;
};

export type ReviewCleanupResult = {
    repo: string;
    number: number;
    ticket?: number;
    branch?: string;
    base?: string;
    steps: ReviewCleanupStepResult[];
    startedat: number;
    endedat: number;
};

export type ReviewCleanupRequest = {
    dir: string;
    repo: string;
    number: number;
    ticket?: number;
    steps?: ReviewCleanupStepId[];
    worktreeconfirmed?: ReviewWorktreeRisk;
};

export function runReviewCleanup(req: ReviewCleanupRequest): Promise<ReviewCleanupResult> {
    return TabRpcClient.wshRpcCall(CleanupCommand, req, { route: ReviewRoute, timeout: CleanupTimeoutMs });
}

// confirmAgentWorktree removes the kept agent worktree and its branch, losing what the developer was shown (the risk).
export function confirmAgentWorktree(
    req: Omit<ReviewCleanupRequest, "steps" | "worktreeconfirmed">,
    risk: ReviewWorktreeRisk
): Promise<ReviewCleanupResult> {
    return runReviewCleanup({ ...req, steps: ["agent-worktree", "local-branch"], worktreeconfirmed: risk });
}

// cleanupNeedsConfirmation is the agent worktree kept because removing it would lose work.
export function cleanupNeedsConfirmation(steps: ReviewCleanupStepResult[]): ReviewCleanupStepResult {
    const step = steps?.find((s) => s.id === "agent-worktree");
    if (step == null || step.confirm == null || step.state === "done" || step.state === "planned") {
        return null;
    }
    return step;
}
