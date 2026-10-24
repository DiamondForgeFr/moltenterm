// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The work asked of a PR's agent and whether it got done (#954, FR-REV-022 AC6 to AC8): a row's Ask for a rebase,
// Investigate, or the list's Check the agents records a task; the row's agent line then tells a running task from a
// done one, and from a stuck one (its agent idle, errored or gone while the goal is not reached). Kept apart from the
// components to be tested alone.

import type { AgentStatesData } from "../agent-state-model";
import type { TFunction } from "../i18n/i18n";
import { checksOf, ReviewPr } from "./reviews-model";
import { AgentBarFacts, panelFacts } from "./reviews-upcoming-model";

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
            // Analyze and resolve (#1020) takes every blocker, not only the CI.
            if (left.conflicts || left.ciRed || left.changesRequested) {
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

// taskAgent (#1057): the agent a task is judged against. A task that names its terminal is judged against that
// terminal only, never against another agent of the branch: on the branch, or still open elsewhere (offBranch), or
// null once the windows no longer know it. A task without a terminal falls back to the branch's first agent.
export function taskAgent(task: PrTask, agents: AgentBarFacts[], states: AgentStatesData): AgentBarFacts {
    if (task == null) {
        return null;
    }
    if (!task.blockId) {
        return agents?.[0] ?? null;
    }
    const placed = agents?.find((a) => a.kind === "panel" && a.blockId === task.blockId);
    if (placed != null) {
        return placed;
    }
    const open = panelFacts(task.blockId, states?.states?.[task.blockId]);
    return open != null ? { ...open, offBranch: true } : null;
}

// One agent line of a card (#1057): an agent of the branch, or the task's own agent; task marks the one the task asked.
export type AgentLine = { facts: AgentBarFacts; task: boolean };

// agentLines: every agent of the branch in its order, the task's agent carrying the task; a task agent that is off the
// branch or gone comes last, so a stuck task still says who stopped.
export function agentLines(agents: AgentBarFacts[], task: PrTask, owner: AgentBarFacts): AgentLine[] {
    const lines: AgentLine[] = (agents ?? []).map((facts) => ({ facts, task: task != null && facts === owner }));
    if (task != null && !lines.some((l) => l.task)) {
        lines.push({ facts: owner, task: true });
    }
    return lines;
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
    // Its terminal is open but on another branch: whatever it does now is not this task.
    if (agent.offBranch) {
        return waited ? "stuck" : "running";
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

// headStillFails (#1020, FR-REV-028 AC8): the checks that fail on the PR's head while its agent stopped (done, or idle
// after its turn was seen), or its task stopped. The agent may say "CI passes" from an older head; the row says what
// fails now, never a silent contradiction. [] when nothing contradicts.
export function headStillFails(pr: ReviewPr, agent: AgentBarFacts, state: PrTaskState): string[] {
    const failed = checksOf(pr?.ci, "failure");
    if (failed.length === 0) {
        return [];
    }
    const agentStopped = agent?.kind === "panel" && (agent.state === "done" || agent.state === "idle");
    if (!agentStopped && state !== "stuck") {
        return [];
    }
    return failed.map((c) => c.name);
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
