// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The batch merge by an agent (FR-REV-025), the window's side: the confirmation modal's order (the suggested merge
// order of the selected PRs, #781), the banner over the Reviews list and the marks on the rows, all drawn from the run
// wavesrv publishes (pkg/molten/review/batch.go). Pure, so it is tested without a window.

import { t, tCount } from "../i18n/i18n";
import { Forecast } from "./reviews-forecast-model";
import { ReviewPr, Tone } from "./reviews-model";
import { MergeOrderStep, mergeOrderReason, suggestedMergeOrder } from "./reviews-order-model";

// must match pkg/molten/review/batch.go
export const BatchStartCommand = "moltenreviewbatchstart";
export const BatchGetCommand = "moltenreviewbatchget";
export const BatchCancelCommand = "moltenreviewbatchcancel";
export const BatchDecideCommand = "moltenreviewbatchdecide";
export const BatchDismissCommand = "moltenreviewbatchdismiss";
export const BatchEvent = "molten:review:batch";

export type BatchState = "running" | "paused" | "cancelling" | "done" | "cancelled" | "interrupted";
export type BatchItemState =
    | "queued"
    | "checking"
    | "rebasing"
    | "waitingchecks"
    | "merging"
    | "merged"
    | "skipped"
    | "stopped";
export type BatchReason =
    | "failing"
    | "ambiguous"
    | "conflict"
    | "agentexited"
    | "agenttimeout"
    | "noagent"
    | "agentmissing"
    | "agentstart"
    | "blocked"
    | "warnings"
    | "citimeout"
    | "unknown"
    | "mergefailed"
    | "read"
    | "headmoved"
    | "draft"
    | "mergedaway"
    | "closed"
    | "notreached"
    | "cancelled"
    | "interrupted";
export type BatchDecision = "retry" | "override" | "skip" | "end";

// The reasons worded under reviews.batch.why; any other reads "not reached".
const WordedReasons = new Set<BatchReason>([
    "failing",
    "ambiguous",
    "conflict",
    "agentexited",
    "agenttimeout",
    "noagent",
    "agentmissing",
    "agentstart",
    "blocked",
    "warnings",
    "citimeout",
    "unknown",
    "mergefailed",
    "read",
    "headmoved",
    "draft",
    "mergedaway",
    "closed",
    "notreached",
    "cancelled",
    "interrupted",
]);
export type BatchKept = "changes" | "unpushed" | "rebasing" | "working" | "unread";
export type BatchMethod = "merge" | "squash" | "rebase";

export type BatchPr = {
    number: number;
    headref: string;
    headoid: string;
    title?: string;
    url?: string;
    ticket?: number;
};

export type BatchItem = BatchPr & {
    state: BatchItemState;
    reason?: BatchReason;
    names?: string[];
    note?: string;
    detail?: string;
    code?: string;
    byyou?: boolean;
    head?: string;
    rebases?: number;
    ciruns?: number;
    waiting?: boolean;
    startedat?: number;
    endedat?: number;
};

export type BatchRun = {
    id: string;
    dir: string;
    repo: string;
    base: string;
    method?: string;
    state: BatchState;
    current: number;
    items: BatchItem[];
    ciruns: number;
    agent?: string;
    agentname?: string;
    blockid?: string;
    tabid?: string;
    worktree?: string;
    workspaceid?: string;
    cleaned?: boolean;
    kept?: BatchKept;
    cancelasked?: boolean;
    dismissed?: boolean;
    startedat: number;
    endedat?: number;
};

export type BatchStartRequest = {
    dir: string;
    repo: string;
    base: string;
    method?: string;
    prs: BatchPr[];
    workspaceid: string;
    tabname?: string;
};

export function batchActive(run: BatchRun): boolean {
    return run?.state === "running" || run?.state === "paused" || run?.state === "cancelling";
}

// batchShown: the banner shows a run that runs, and an ended one until the developer dismisses it.
export function batchShown(run: BatchRun): boolean {
    return run != null && (batchActive(run) || !run.dismissed);
}

export function batchItemEnded(item: BatchItem): boolean {
    return item.state === "merged" || item.state === "skipped";
}

// The PRs the developer can select for a batch: the ones waiting for review (never a draft).
export function batchSelectable(pr: ReviewPr): boolean {
    return pr != null && !pr.draft;
}

export function toggleBatchSelection(selected: number[], number: number): number[] {
    return selected.includes(number) ? selected.filter((n) => n !== number) : [...selected, number];
}

export type BatchPlanStep = { pr: ReviewPr; rank: number; reason: string; rebase: boolean };

// BatchPlan is what the confirmation modal shows: the selected PRs in the suggested order (their list order while the
// forecast cannot say), and the CI runs that order should redo.
export type BatchPlan = {
    steps: BatchPlanStep[];
    usable: boolean;
    cost: number;
    uptodate: string;
    method: string;
};

export function batchPlan(forecast: Forecast, selected: ReviewPr[], listed: ReviewPr[], base: string): BatchPlan {
    const prs = (selected ?? []).filter(batchSelectable);
    const order = suggestedMergeOrder(forecast, prs, listed);
    const byNumber = new Map(prs.map((pr) => [pr.number, pr]));
    const stepOf = new Map<number, MergeOrderStep>(order.steps.map((s) => [s.number, s]));
    const steps = order.numbers
        .filter((n) => byNumber.has(n))
        .map((n, i) => {
            const pr = byNumber.get(n);
            const step = stepOf.get(n);
            return {
                pr,
                rank: i + 1,
                reason: step != null ? mergeOrderReason(step, base, pr) : "",
                rebase: step?.rebase ?? false,
            };
        });
    return {
        steps,
        usable: order.usable,
        cost: order.cost,
        uptodate: order.uptodate,
        method: forecast?.method ?? "",
    };
}

export function batchPrOf(pr: ReviewPr): BatchPr {
    return {
        number: pr.number,
        headref: pr.branch,
        headoid: pr.headoid,
        title: pr.tickettitle || pr.title,
        url: pr.url,
        ticket: pr.ticket,
    };
}

export function batchStartRequest(
    dir: string,
    repo: string,
    base: string,
    plan: BatchPlan,
    workspaceid: string
): BatchStartRequest {
    return {
        dir,
        repo,
        base,
        method: plan.method || undefined,
        prs: plan.steps.map((s) => batchPrOf(s.pr)),
        workspaceid,
        tabname: t("reviews.batch.tabName"),
    };
}

export function methodText(method: string): string {
    switch (method) {
        case "merge":
            return t("reviews.batch.method.merge");
        case "squash":
            return t("reviews.batch.method.squash");
        case "rebase":
            return t("reviews.batch.method.rebase");
    }
    return t("reviews.batch.method.repository");
}

// batchPlanCostText: what the modal says of the CI runs the order should redo.
export function batchPlanCostText(plan: BatchPlan): string {
    if (!plan.usable) {
        return t("reviews.batch.confirm.costUnknown");
    }
    if (plan.uptodate === "required") {
        return t("reviews.batch.confirm.costUpToDate");
    }
    return tCount("reviews.batch.confirm.cost", plan.cost);
}

// batchConfirmKey: Enter starts, Escape cancels; nothing else answers the modal.
export function batchConfirmKey(key: string): "start" | "cancel" | null {
    if (key === "Enter") {
        return "start";
    }
    if (key === "Escape") {
        return "cancel";
    }
    return null;
}

export function batchCurrent(run: BatchRun): BatchItem {
    if (run == null || run.current < 0 || run.current >= run.items.length) {
        return null;
    }
    return run.items[run.current];
}

export function batchMergedCount(run: BatchRun): number {
    return (run?.items ?? []).filter((it) => it.state === "merged").length;
}

// batchPosition: "2 of 5", the PR in progress (or the PRs done once it ended).
export function batchPosition(run: BatchRun): number {
    if (run == null) {
        return 0;
    }
    if (run.current >= 0) {
        return run.current + 1;
    }
    return run.items.filter(batchItemEnded).length;
}

export function batchAgentName(run: BatchRun): string {
    return run?.agentname || t("reviews.batch.yourAgent");
}

export function batchTitle(run: BatchRun): string {
    const count = run.items.length;
    const vars = {
        position: batchPosition(run),
        merged: batchMergedCount(run),
        number: batchCurrent(run)?.number ?? 0,
    };
    switch (run.state) {
        case "running":
            return tCount("reviews.batch.banner.running", count, vars);
        case "cancelling":
            return tCount("reviews.batch.banner.cancelling", count, vars);
        case "paused":
            return tCount("reviews.batch.banner.paused", count, vars);
        case "done":
            return tCount("reviews.batch.banner.done", count, vars);
        case "cancelled":
            return tCount("reviews.batch.banner.cancelled", count, vars);
    }
    return tCount("reviews.batch.banner.interrupted", count, vars);
}

// batchStepText: what happens to the PR in progress, in one line.
export function batchStepText(run: BatchRun, item: BatchItem): string {
    if (item == null) {
        return "";
    }
    const vars = { number: item.number, base: run.base, name: batchAgentName(run) };
    if (item.waiting) {
        return t("reviews.batch.step.waiting", vars);
    }
    switch (item.state) {
        case "queued":
            return t("reviews.batch.step.queued", vars);
        case "checking":
            return t("reviews.batch.step.checking", vars);
        case "rebasing":
            return t("reviews.batch.step.rebasing", vars);
        case "waitingchecks":
            return (item.rebases ?? 0) > 0
                ? t("reviews.batch.step.waitingRebased", vars)
                : t("reviews.batch.step.waitingChecks", vars);
        case "merging":
            return t("reviews.batch.step.merging", vars);
        case "merged":
            return t("reviews.batch.step.merged", vars);
    }
    return batchReasonText(item, run.base);
}

export function batchReasonText(item: BatchItem, base: string): string {
    const vars = {
        names: (item.names ?? []).join(", "),
        note: item.note ?? "",
        detail: [item.detail, item.code].filter(Boolean).join(" "),
        base,
    };
    if (item.reason === "ambiguous" && item.note) {
        return t("reviews.batch.why.ambiguousNote", vars);
    }
    if (!WordedReasons.has(item.reason)) {
        return t("reviews.batch.why.notreached", vars);
    }
    return t(`reviews.batch.why.${item.reason}`, vars);
}

// batchDecisions: what the developer can answer on a stopped PR. Merge anyway only for warnings (unpublished
// comments, work in progress): a failing check is never overridden.
export function batchDecisions(item: BatchItem): BatchDecision[] {
    if (item?.state !== "stopped") {
        return [];
    }
    if (item.reason === "warnings") {
        return ["override", "skip", "end"];
    }
    return ["retry", "skip", "end"];
}

export function batchDecisionLabel(decision: BatchDecision): string {
    return t(`reviews.batch.decide.${decision}`);
}

export function batchKeptText(kept: BatchKept): string {
    return kept ? t(`reviews.batch.kept.${kept}`) : "";
}

// batchSummary: the ended run's merged and skipped PRs, the skipped ones with their reasons, and the CI runs redone.
export function batchSummary(run: BatchRun): string {
    const merged = run.items.filter((it) => it.state === "merged").map((it) => `#${it.number}`);
    const skipped = run.items
        .filter((it) => it.state !== "merged")
        .map((it) =>
            t("reviews.batch.summary.skippedItem", { number: it.number, reason: batchReasonText(it, run.base) })
        );
    const parts = [
        merged.length > 0
            ? t("reviews.batch.summary.merged", { list: merged.join(", ") })
            : t("reviews.batch.summary.mergedNone"),
    ];
    if (skipped.length > 0) {
        parts.push(t("reviews.batch.summary.skipped", { list: skipped.join(", ") }));
    }
    parts.push(tCount("reviews.batch.summary.ciRuns", run.ciruns ?? 0));
    if (run.kept) {
        parts.push(batchKeptText(run.kept));
    }
    return parts.join(" ");
}

export type BatchRowMark = { label: string; tone: Tone; title: string; current: boolean };

// batchRowMark: the PR's place in the run, on its row of the Reviews list; null when it is not part of the run shown.
export function batchRowMark(run: BatchRun, number: number): BatchRowMark {
    if (!batchShown(run)) {
        return null;
    }
    const index = run.items.findIndex((it) => it.number === number);
    if (index < 0) {
        return null;
    }
    const item = run.items[index];
    const current = index === run.current && batchActive(run) && item.state !== "stopped";
    const step = batchStepText(run, item);
    switch (item.state) {
        case "merged":
            return { label: t("reviews.batch.row.merged"), tone: "success", title: step, current };
        case "stopped":
            return { label: t("reviews.batch.row.stopped"), tone: "failure", title: step, current };
        case "skipped":
            return { label: t("reviews.batch.row.skipped"), tone: "neutral", title: step, current };
        case "queued":
            return {
                label: t("reviews.batch.row.queued", { rank: index + 1 }),
                tone: "neutral",
                title: step,
                current,
            };
    }
    return { label: t("reviews.batch.row.current"), tone: item.waiting ? "failure" : "pending", title: step, current };
}
