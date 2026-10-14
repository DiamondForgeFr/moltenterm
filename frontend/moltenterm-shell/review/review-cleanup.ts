// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The cleanup after a merge (FR-REV-013, DS-REV-010), run by wavesrv (pkg/molten/review/cleanup.go): Validate calls it
// right after its merge, and it also runs on its own for a PR merged earlier. Each step comes back done, skipped (why)
// or failed (the message); the agent worktree kept for its risk comes back with the plan to confirm a second time.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { t } from "../i18n/i18n";
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

export type ReviewCleanupPr = {
    number: number;
    branch: string;
    state: ReviewCleanupState;
    reason?: string;
    message?: string;
    flag?: "agent-busy" | "needs-rebase";
};

export type ReviewCleanupStepResult = {
    id: ReviewCleanupStepId;
    state: ReviewCleanupStepState;
    reason?: string;
    message?: string;
    // The agent worktree's plan (mission WorktreePlan) and the risk to send back once the developer confirms it.
    worktree?: { path: string; changes: string[]; changecount: number; unpushed: number; terminals: unknown[] };
    confirm?: ReviewWorktreeRisk;
    prs?: ReviewCleanupPr[];
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

// confirmAgentWorktree runs the agent worktree's removal again, with the risk the developer confirmed, and the branch
// that depended on it.
export function confirmAgentWorktree(
    req: Omit<ReviewCleanupRequest, "steps" | "worktreeconfirmed">,
    risk: ReviewWorktreeRisk
): Promise<ReviewCleanupResult> {
    return runReviewCleanup({ ...req, steps: ["agent-worktree", "local-branch"], worktreeconfirmed: risk });
}

const StepLabelKeys: Record<ReviewCleanupStepId, string> = {
    pr: "review.cleanup.step.pr",
    "ticket-close": "review.cleanup.step.ticketClose",
    "ticket-done": "review.cleanup.step.ticketDone",
    "review-worktree": "review.cleanup.step.reviewWorktree",
    "agent-worktree": "review.cleanup.step.agentWorktree",
    "local-branch": "review.cleanup.step.localBranch",
    "remote-branch": "review.cleanup.step.remoteBranch",
    "other-prs": "review.cleanup.step.otherPrs",
};

export function cleanupStepLabel(id: ReviewCleanupStepId): string {
    return StepLabelKeys[id] ? t(StepLabelKeys[id]) : id;
}

// cleanupStepDetail is the line under a step: why it was skipped, the error that made it fail, or what it did.
export function cleanupStepDetail(step: ReviewCleanupStepResult): string {
    if (step.state === "skipped") {
        return step.reason ?? "";
    }
    return step.message ?? "";
}

export function cleanupPrDetail(pr: ReviewCleanupPr): string {
    if (pr.state === "done") {
        return t("review.cleanup.prRebased");
    }
    if (pr.state === "failed") {
        return pr.message ?? t("review.cleanup.state.failed");
    }
    return pr.reason ?? "";
}

// cleanupNeedsConfirmation is the agent worktree step waiting for the second confirmation of its plan.
export function cleanupNeedsConfirmation(steps: ReviewCleanupStepResult[]): ReviewCleanupStepResult {
    const step = steps?.find((s) => s.id === "agent-worktree");
    if (step == null || step.confirm == null || step.state === "done") {
        return null;
    }
    return step;
}

// cleanupSummary counts the steps by state, for a sheet's header.
export function cleanupSummary(result: ReviewCleanupResult): Record<ReviewCleanupState, number> {
    const rtn: Record<ReviewCleanupState, number> = { done: 0, skipped: 0, failed: 0 };
    for (const step of result?.steps ?? []) {
        if (step.state === "planned") {
            continue;
        }
        rtn[step.state] = (rtn[step.state] ?? 0) + 1;
    }
    return rtn;
}
