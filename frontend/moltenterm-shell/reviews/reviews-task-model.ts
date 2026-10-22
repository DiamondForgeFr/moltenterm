// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The work asked of a PR's agent and whether it got done (#954, FR-REV-022 AC6 to AC8): a row's Ask for a rebase,
// Investigate, or the list's Check the agents records a task; the row's agent line then tells a running task from a
// done one, and from a stuck one (its agent idle, errored or gone while the goal is not reached). Kept apart from the
// components to be tested alone.

import type { TFunction } from "../i18n/i18n";
import { checksOf, ReviewPr } from "./reviews-model";
import type { AgentBarFacts } from "./reviews-upcoming-model";

export type PrTaskKind = "rebase" | "investigate" | "finish";

// A task asked of the agent on a PR: the agent's name and terminal when one took it, the PR's head and when.
export type PrTask = { kind: PrTaskKind; name: string; blockId?: string; head: string; at: number };

export type PrTaskState = "running" | "stuck" | "done";

// What the Reviews list reads as left on a PR.
export type PrLeft = {
    conflicts: boolean;
    ciRed: boolean;
    failedChecks: string[];
    changesRequested: boolean;
    noReport: boolean;
};

// An agent that took a task and has not moved since is given this long before its task reads as stuck: a prompt typed
// in its terminal takes a moment to start it.
export const StuckGraceMs = 2 * 60_000;

export function prLeft(pr: ReviewPr): PrLeft {
    const failedChecks = checksOf(pr?.ci, "failure").map((c) => c.name);
    return {
        conflicts: pr?.merge === "conflicts",
        ciRed: failedChecks.length > 0 || pr?.ci?.state === "failure",
        failedChecks,
        changesRequested: pr?.reviewdecision === "CHANGES_REQUESTED",
        noReport: pr?.report?.state === "missing",
    };
}

export function prNeedsWork(left: PrLeft): boolean {
    return left.conflicts || left.ciRed || left.changesRequested || left.noReport;
}

// taskGoal: reached, pending (the CI runs, the outcome is not known yet) or left.
export function taskGoal(task: PrTask, pr: ReviewPr): "reached" | "pending" | "left" {
    if (task == null || pr == null) {
        return "left";
    }
    const left = prLeft(pr);
    const ciRuns = pr.ci?.state === "pending";
    switch (task.kind) {
        case "rebase":
            return left.conflicts ? "left" : "reached";
        case "investigate":
            if (left.ciRed) {
                return "left";
            }
            return ciRuns ? "pending" : "reached";
        case "finish":
            if (left.conflicts || left.ciRed || left.changesRequested) {
                return "left";
            }
            return ciRuns ? "pending" : "reached";
    }
    return "left";
}

// The agent that took the task, as the line sees it now: live (on the PR's branch, the same terminal when the task
// names one), or gone.
export function taskAgentLive(task: PrTask, agent: AgentBarFacts): boolean {
    if (agent == null) {
        return false;
    }
    // A background agent is a guess from the worktree's activity: it stands for the task's agent only when the task
    // named no terminal.
    if (agent.kind === "background") {
        return !task?.blockId;
    }
    return !task?.blockId || agent.blockId === task.blockId;
}

// prTaskState: done once the goal is reached; running while the agent works, waits for the developer or the CI runs;
// stuck when the agent is idle, done or errored since the ask (or has not moved for StuckGraceMs), or gone, while the
// goal is not reached.
export function prTaskState(task: PrTask, pr: ReviewPr, agent: AgentBarFacts, now: number): PrTaskState {
    if (task == null) {
        return null;
    }
    const goal = taskGoal(task, pr);
    if (goal === "reached") {
        return "done";
    }
    if (goal === "pending") {
        return "running";
    }
    const live = taskAgentLive(task, agent);
    const waited = now - task.at >= StuckGraceMs;
    if (!live) {
        return waited ? "stuck" : "running";
    }
    if (agent.kind === "background") {
        return "running";
    }
    if (agent.errored) {
        return "stuck";
    }
    if (agent.state === "working" || agent.state === "waiting") {
        return "running";
    }
    const movedSince = (agent.stateSince ?? 0) > task.at;
    return movedSince || waited ? "stuck" : "running";
}

// leftText: what is left, in the interface language ("conflicts with develop, CI red").
export function leftText(t: TFunction, left: PrLeft, base: string): string {
    const parts: string[] = [];
    if (left.conflicts) {
        parts.push(t("reviewsAgents.task.left.conflicts", { base }));
    }
    if (left.ciRed) {
        parts.push(t("reviewsAgents.task.left.ci"));
    }
    if (left.changesRequested) {
        parts.push(t("reviewsAgents.task.left.changes"));
    }
    if (left.noReport) {
        parts.push(t("reviewsAgents.task.left.report"));
    }
    return parts.join(", ");
}

// taskStateText: the line's words for a task that is stuck or done ("stopped before finishing the rebase: conflicts
// remain"); "" while it runs (the agent's own state says it).
export function taskStateText(t: TFunction, task: PrTask, state: PrTaskState, live: boolean, pr: ReviewPr): string {
    if (task == null || state == null || state === "running") {
        return "";
    }
    if (state === "done") {
        return t(`reviewsAgents.task.done.${task.kind}`);
    }
    const what = t(`reviewsAgents.task.what.${task.kind}`);
    const left = leftText(t, prLeft(pr), pr?.base ?? "");
    return t(live ? "reviewsAgents.task.stuck" : "reviewsAgents.task.gone", { what, left });
}

// The list's Check the agents (FR-REV-022 AC8): the PRs with something left, the others skipped.
export type CheckPlan = { checked: number; needs: ReviewPr[] };

export function checkAgentsPlan(prs: ReviewPr[]): CheckPlan {
    const needs = (prs ?? []).filter((pr) => prNeedsWork(prLeft(pr)));
    return { checked: prs?.length ?? 0, needs };
}

// What the check reports once every PR was asked.
export type CheckReport = {
    checked: number;
    needs: number;
    sent: number;
    busy: number;
    // The PRs whose agent is gone: a new agent starts on each only on the developer's confirmation.
    offers: ReviewPr[];
    started: number;
    failed: number;
};

type TCount = (key: string, count: number) => string;

// checkReportText: "3 checked, 1 needs work · 1 sent to its agent".
export function checkReportText(tCount: TCount, r: CheckReport): string {
    const parts = [`${tCount("reviews.check.checked", r.checked)}, ${tCount("reviews.check.needs", r.needs)}`];
    const counts: [string, number][] = [
        ["reviews.check.sent", r.sent],
        ["reviews.check.busy", r.busy],
        ["reviews.check.started", r.started],
        ["reviews.check.failed", r.failed],
    ];
    for (const [key, count] of counts) {
        if (count > 0) {
            parts.push(tCount(key, count));
        }
    }
    return parts.join(" · ");
}
