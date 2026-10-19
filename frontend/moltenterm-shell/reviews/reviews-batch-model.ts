// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The merge queue (FR-REV-026, #912), which the batch merge feeds (FR-REV-025), the window's side: the confirmation
// modal's order (the suggested merge order of the selected PRs, #781), the order sent each time PRs join, the banner
// over the Reviews list and the marks on the rows, all drawn from the queue wavesrv publishes
// (pkg/molten/review/batch.go). Pure, so it is tested without a window.

import { t, tCount } from "../i18n/i18n";
import { Forecast } from "./reviews-forecast-model";
import { ReviewPr, Tone } from "./reviews-model";
import { MergeOrderStep, mergeOrderReason, suggestedMergeOrder } from "./reviews-order-model";

// must match pkg/molten/review/batch.go
export const QueueAddCommand = "moltenreviewqueueadd";
export const QueueWithdrawCommand = "moltenreviewqueuewithdraw";
export const BatchGetCommand = "moltenreviewbatchget";
export const BatchCancelCommand = "moltenreviewbatchcancel";
export const BatchDismissCommand = "moltenreviewbatchdismiss";
export const BatchEvent = "molten:review:batch";

export type BatchState = "running" | "cancelling" | "done" | "cancelled" | "interrupted";
export type BatchItemState =
    | "queued"
    | "checking"
    | "rebasing"
    | "waitingchecks"
    | "merging"
    | "merged"
    | "skipped"
    | "stopped"
    | "failed"
    | "voided"
    | "withdrawn";
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
    | "interrupted"
    | "pushed"
    | "withdrawn";

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
    "pushed",
    "withdrawn",
]);
export type BatchKept = "changes" | "unpushed" | "rebasing" | "working" | "unread";
export type BatchMethod = "merge" | "squash" | "rebase";

// A PR joining the queue: from the batch modal, bound to its listed head; from the Validate sheet, by its plan.
export type BatchPr = {
    number: number;
    headref: string;
    headoid: string;
    title?: string;
    url?: string;
    ticket?: number;
    planid?: string;
    method?: string;
    override?: boolean;
};

export type BatchItem = BatchPr & {
    state: BatchItemState;
    source?: "validate" | "batch";
    valid?: string;
    overridden?: string[];
    validatedat?: number;
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
    resumedat?: number;
    startedat: number;
    endedat?: number;
};

export type QueueAddRequest = {
    dir: string;
    repo: string;
    base: string;
    method?: string;
    prs: BatchPr[];
    source?: "validate" | "batch";
    order?: number[];
    workspaceid: string;
    tabname?: string;
};

export function batchActive(run: BatchRun): boolean {
    return run?.state === "running" || run?.state === "cancelling";
}

// batchShown: the banner shows a queue that runs, and an ended one until the developer dismisses it.
export function batchShown(run: BatchRun): boolean {
    return run != null && (batchActive(run) || !run.dismissed);
}

// batchItemEnded: the PR left the queue for good (a new validation may put it back).
export function batchItemEnded(item: BatchItem): boolean {
    return ["merged", "skipped", "stopped", "voided", "withdrawn"].includes(item?.state);
}

// queueItem: the PR's place in a running queue (waiting, in progress or set aside on a failing check), null otherwise.
export function queueItem(run: BatchRun, number: number): BatchItem {
    if (!batchActive(run)) {
        return null;
    }
    const item = run.items.find((it) => it.number === number);
    return item != null && !batchItemEnded(item) ? item : null;
}

// canWithdraw: Cancel validation, until the merge starts.
export function canWithdraw(item: BatchItem): boolean {
    return item != null && !batchItemEnded(item) && item.state !== "merging";
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

// queueOrder: the suggested order (#781) of the PRs of the queue and of the ones joining it, sent on each join so the
// PRs not started yet follow it; none while the forecast cannot say (they keep the order they joined in).
export function queueOrder(forecast: Forecast, listed: ReviewPr[], run: BatchRun, joining: number[]): number[] {
    const numbers = new Set<number>(joining);
    for (const it of batchActive(run) ? run.items : []) {
        if (!batchItemEnded(it)) {
            numbers.add(it.number);
        }
    }
    const prs = (listed ?? []).filter((pr) => numbers.has(pr.number) && batchSelectable(pr));
    const order = suggestedMergeOrder(forecast, prs, listed);
    return order.usable ? order.numbers : [];
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

// batchStartRequest: the modal's PRs join the queue in the order shown, bound to the heads listed.
export function batchStartRequest(
    dir: string,
    repo: string,
    base: string,
    plan: BatchPlan,
    workspaceid: string,
    order?: number[]
): QueueAddRequest {
    const shown = plan.steps.map((s) => s.pr.number);
    return {
        dir,
        repo,
        base,
        method: plan.method || undefined,
        prs: plan.steps.map((s) => batchPrOf(s.pr)),
        source: "batch",
        order: order?.length ? order : shown,
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

export function batchAgentName(run: BatchRun): string {
    return run?.agentname || t("reviews.batch.yourAgent");
}

// batchNowText: the PR in progress in a few words, for the banner's title.
export function batchNowText(item: BatchItem): string {
    if (item.waiting) {
        return t("reviews.batch.banner.now.waiting");
    }
    switch (item.state) {
        case "queued":
        case "checking":
        case "rebasing":
        case "waitingchecks":
        case "merging":
            return t(`reviews.batch.banner.now.${item.state}`);
    }
    return t("reviews.batch.banner.now.other");
}

// The banner counts the merged PRs, never the position: "12 of 12" read as done while the last PR still waited for its
// checks (#887).
export function batchTitle(run: BatchRun): string {
    const count = run.items.length;
    const current = batchCurrent(run);
    const merged = batchMergedCount(run);
    const progress =
        current == null
            ? t("reviews.batch.banner.progressIdle", { merged, count })
            : t("reviews.batch.banner.progress", { merged, count, number: current.number, now: batchNowText(current) });
    const vars = { progress, merged, number: current?.number ?? 0, base: run.base };
    switch (run.state) {
        case "running":
            return tCount("reviews.batch.banner.running", count, vars);
        case "cancelling":
            return tCount("reviews.batch.banner.cancelling", count, vars);
        case "done":
            return tCount("reviews.batch.banner.done", count, vars);
        case "cancelled":
            return tCount("reviews.batch.banner.cancelled", count, vars);
    }
    return tCount("reviews.batch.banner.interrupted", count, vars);
}

// batchStepText: what happens to the PR, in one line.
export function batchStepText(run: BatchRun, item: BatchItem): string {
    if (item == null) {
        return "";
    }
    const vars = {
        number: item.number,
        base: run.base,
        name: batchAgentName(run),
        names: (item.names ?? []).join(", "),
    };
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
        case "failed":
            return t("reviews.batch.step.failed", vars);
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

export function batchKeptText(kept: BatchKept): string {
    return kept ? t(`reviews.batch.kept.${kept}`) : "";
}

// batchSummary: the ended queue's merged PRs and the others with their reasons, and the CI runs redone.
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

// queueRank: the PR's place among the PRs still waiting their turn (1: next), 0 when it is not waiting.
export function queueRank(run: BatchRun, number: number): number {
    const waiting = (run?.items ?? []).filter((it) => it.state === "queued");
    return waiting.findIndex((it) => it.number === number) + 1;
}

export type BatchRowMark = { label: string; tone: Tone; title: string; current: boolean };

// batchRowMark: the PR's place in the queue, on its row of the Reviews list (FR-REV-026 AC7); null when it is not part
// of the queue shown.
export function batchRowMark(run: BatchRun, number: number): BatchRowMark {
    if (!batchShown(run)) {
        return null;
    }
    const index = run.items.findIndex((it) => it.number === number);
    if (index < 0) {
        return null;
    }
    const item = run.items[index];
    const current = index === run.current && batchActive(run);
    const title = batchStepText(run, item);
    const mark = (key: string, tone: Tone, vars: Record<string, string | number> = {}): BatchRowMark => ({
        label: t(`reviews.batch.row.${key}`, vars),
        tone,
        title,
        current,
    });
    if (item.waiting) {
        return mark("needsAnswer", "failure");
    }
    switch (item.state) {
        case "merged":
            return mark("merged", "success");
        case "stopped":
            return mark("stopped", "failure");
        case "failed":
            return mark("failed", "failure");
        case "voided":
            return mark("voided", "neutral");
        case "withdrawn":
            return mark("withdrawn", "neutral");
        case "skipped":
            return mark("skipped", "neutral");
        case "queued": {
            const rank = queueRank(run, number);
            return rank === 1 ? mark("next", "neutral") : mark("queued", "neutral", { rank });
        }
        case "waitingchecks":
            return mark((item.rebases ?? 0) > 0 ? "waitingRebased" : "waiting", "pending");
        case "rebasing":
            return mark("rebasing", "pending");
        case "merging":
            return mark("merging", "pending");
    }
    return mark("current", "pending");
}
