// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The cleanup after a merge (FR-REV-013, DS-REV-010), run by wavesrv (pkg/molten/review/cleanup.go): Validate calls it
// right after its merge, and it also runs on its own for a PR merged earlier. Each step comes back done, skipped or
// failed with a code and its data, which the Validate sheet writes in the interface's language (review-stepper.ts).
// The cleanup is complete by default (#672): a worktree is kept only when removing it would lose work, and then comes
// back with what it would lose and the risk to confirm.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { ServerText } from "../i18n/server-text";
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
    | "local-trunk"
    | "other-prs"
    // #1121: the PR's local copies the request names (the Leftovers group only, never Validate's sheet).
    | "copy-branches";

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
    "local-trunk",
    "other-prs",
];

// must match WorktreeRisk in pkg/molten/mission/worktree.go
export type ReviewWorktreeRisk = {
    sha: string;
    changecount: number;
    unpushed: number;
    ignoredfilecount: number;
    // #1121: the worktree's lock is held by a process that ended; wavesrv checks it again before removing.
    endedlock?: boolean;
};

// must match WorktreeLoss in pkg/molten/review/loss.go; commitcount -1: git could not tell.
export type ReviewWorktreeLoss = {
    changes: string[];
    changecount: number;
    commits: { sha: string; subject: string }[];
    commitcount: number;
    ignored: string[];
    ignoredcount: number;
};

// must match CleanupPanel in pkg/molten/review/cleanup.go: a terminal still open in a kept worktree; agent: the state
// of the agent running in it, "" when none.
export type ReviewCleanupPanel = { blockid: string; tab?: string; workspace?: string; agent?: string };

// must match CleanupFlag… in pkg/molten/review/cleanup.go (#691): what became of a PR the merge put in conflict, or
// checking when GitHub had not told whether it merges cleanly in time. No flag: unaffected.
export type ReviewCleanupPrFlag =
    | "rebase-asked"
    | "rebase-typed"
    | "agent-busy"
    | "needs-agent"
    | "needs-rebase"
    | "checking"
    | "batch";

// must match CleanupPr in pkg/molten/review/cleanup.go; agent: the first name of the agent asked or busy.
export type ReviewCleanupPr = {
    number: number;
    branch: string;
    url?: string;
    title?: string;
    headoid?: string;
    state: ReviewCleanupState;
    flag?: ReviewCleanupPrFlag;
    agent?: string;
    error?: string;
    errortext?: ServerText;
};

export type ReviewCleanupStepResult = {
    id: ReviewCleanupStepId;
    state: ReviewCleanupStepState;
    code?: string;
    error?: string;
    errortext?: ServerText;
    ticket?: number;
    branch?: string;
    base?: string;
    path?: string;
    loss?: ReviewWorktreeLoss;
    // The kept agent worktree's risk, sent back to remove it and lose its work.
    confirm?: ReviewWorktreeRisk;
    panels?: ReviewCleanupPanel[];
    prs?: ReviewCleanupPr[];
    unaffected?: number;
    conflicting?: number;
    checking?: number;
    failed?: number;
    // The local working branch (#909): count, the commits it was behind origin; ahead, its commits origin lacks; names
    // (the first namecount), the local changes the update would overwrite.
    count?: number;
    ahead?: number;
    names?: string[];
    namecount?: number;
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
    // Remove again on the folder a worktree step left (code leftover, #716); wavesrv only removes the one it recorded.
    leftover?: string;
    // #1121, the Leftovers group: a PR closed without merging whose content is on the base, and the PR's local copies.
    closed?: boolean;
    copies?: string[];
};

export function runReviewCleanup(req: ReviewCleanupRequest): Promise<ReviewCleanupResult> {
    return TabRpcClient.wshRpcCall(CleanupCommand, req, { route: ReviewRoute, timeout: CleanupTimeoutMs });
}

// Removing a kept agent worktree also deletes origin's branch, after the local one (#1132): wavesrv keeps it while
// the worktree or the local branch stays.
const AgentTreeSteps: ReviewCleanupStepId[] = ["agent-worktree", "local-branch", "remote-branch"];

// confirmAgentWorktree removes the kept agent worktree and its branch, losing what the developer was shown (the risk).
export function confirmAgentWorktree(
    req: Omit<ReviewCleanupRequest, "steps" | "worktreeconfirmed">,
    risk: ReviewWorktreeRisk
): Promise<ReviewCleanupResult> {
    return runReviewCleanup({ ...req, steps: AgentTreeSteps, worktreeconfirmed: risk });
}

// removeKeptWorktree removes a kept worktree once the sheet closed the panels still open in it: the agent worktree
// with its branch (losing what the developer was shown, when it holds work), or the review worktree. wavesrv checks
// the folder again, so a panel opened since keeps it.
export function removeKeptWorktree(
    req: Omit<ReviewCleanupRequest, "steps" | "worktreeconfirmed">,
    step: ReviewCleanupStepResult
): Promise<ReviewCleanupResult> {
    if (step.id === "review-worktree") {
        return runReviewCleanup({ ...req, steps: ["review-worktree"] });
    }
    if (step.code === "kept" && step.confirm != null) {
        return confirmAgentWorktree(req, step.confirm);
    }
    return runReviewCleanup({ ...req, steps: AgentTreeSteps });
}

// removeLeftover removes again the folder a worktree step left after git unregistered the worktree (#716).
export function removeLeftover(
    req: Omit<ReviewCleanupRequest, "steps" | "worktreeconfirmed" | "leftover">,
    step: ReviewCleanupStepResult
): Promise<ReviewCleanupResult> {
    return runReviewCleanup({ ...req, steps: [step.id], leftover: step.path });
}

// cleanupLeftovers are the worktree steps that left a folder behind: a warning with Show in folder and Remove again.
export function cleanupLeftovers(steps: ReviewCleanupStepResult[]): ReviewCleanupStepResult[] {
    return (steps ?? []).filter(
        (s) => (s.id === "review-worktree" || s.id === "agent-worktree") && s.code === "leftover" && !!s.path
    );
}

// cleanupNeedsConfirmation is the agent worktree kept because removing it would lose work or a panel works in it.
export function cleanupNeedsConfirmation(steps: ReviewCleanupStepResult[]): ReviewCleanupStepResult {
    const step = steps?.find((s) => s.id === "agent-worktree");
    if (step == null || step.confirm == null || step.state === "done" || step.state === "planned") {
        return null;
    }
    return step;
}
