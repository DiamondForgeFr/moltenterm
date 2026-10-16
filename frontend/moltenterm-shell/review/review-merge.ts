// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Validate's plan sheet, the pure part (FR-REV-012, DS-REV-010): when Merge can be clicked and why not, and which merge
// and cleanup the sheet shows. wavesrv decides again on the click; the sheet only reflects the plan. The steps
// themselves are review-stepper.ts.

import { t } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import type { ReviewCleanupResult } from "./review-cleanup";
import { ReviewMergeMethod, ReviewMergePlan, ReviewMergeRecord, ReviewMergeState } from "./review-client";
import { blockingText } from "./review-stepper";

const RunningStates: ReviewMergeState[] = ["checking", "updating", "waitingci", "merging", "queued"];

// must match mergeErrorPrefix and MergeErr… in pkg/molten/review/merge.go
const MergeErrorRe = /molten-review-merge:(running|stale|old|blocked|confirm|nomerge|method)/;

export function mergeRunning(record: ReviewMergeRecord): boolean {
    return record != null && RunningStates.includes(record.state);
}

// The record the sheet shows: a merge still running wherever it was started, else the one this plan started.
export function sheetRecord(record: ReviewMergeRecord, planid: string): ReviewMergeRecord {
    if (record == null) {
        return null;
    }
    if (mergeRunning(record) || (planid != null && record.planid === planid)) {
        return record;
    }
    return null;
}

// Merge is clickable when the plan allows it, its warnings are confirmed and no merge of the PR is running (AC4).
export function canClickMerge(plan: ReviewMergePlan, override: boolean, record: ReviewMergeRecord): boolean {
    if (plan == null || !plan.canmerge || mergeRunning(record)) {
        return false;
    }
    return (plan.warnings ?? []).length === 0 || override;
}

// Why Merge is disabled, as its tooltip and the line under the steps say.
export function mergeDisabledReason(plan: ReviewMergePlan, override: boolean, record: ReviewMergeRecord): string {
    if (plan == null) {
        return t("review.merge.reading");
    }
    if (mergeRunning(record)) {
        return t("review.merge.running");
    }
    if (!plan.canmerge) {
        return blockingText(
            t,
            plan.checks.find((c) => c.id === plan.blocking)
        );
    }
    if ((plan.warnings ?? []).length > 0 && !override) {
        return t("review.merge.confirmWarnings");
    }
    return "";
}

// chosenMethod is the method the merge uses: the one picked in the sheet while the plan allows it, else the plan's
// default (#673). Plans made before #673 had no methods: a rebase.
export function chosenMethod(plan: ReviewMergePlan, picked: ReviewMergeMethod): ReviewMergeMethod {
    const methods = plan?.methods ?? [];
    if (picked != null && methods.includes(picked)) {
        return picked;
    }
    return plan?.method ?? methods[0] ?? "rebase";
}

export function mergeButtonLabel(plan: ReviewMergePlan, method: ReviewMergeMethod): string {
    if (plan?.queue) {
        return t("review.merge.button.queue");
    }
    if (plan?.behind) {
        return t("review.merge.updateThenMerge");
    }
    return t(`review.merge.button.${method ?? "rebase"}`);
}

// validateErrorText is what the sheet says for a refused command: wavesrv's codes in the interface's language, any other
// error (gh, git) as it came.
export function validateErrorText(error: string): string {
    const match = MergeErrorRe.exec(error ?? "");
    if (match == null) {
        return serverErrorText(error);
    }
    return t(`review.validate.error.${match[1]}`);
}

// The wait can be stopped only before the merge call, or while a merge queue holds the PR (it then stays in the queue):
// GitHub's merge is not undone.
export function canCancelMerge(record: ReviewMergeRecord): boolean {
    return record != null && ["updating", "waitingci", "queued"].includes(record.state);
}

// mergeCleanup is the cleanup the merge ran, from the review store: none before the merge, and never an older run
// (a cleanup started by hand before this merge).
export function mergeCleanup(record: ReviewMergeRecord, cleanup: ReviewCleanupResult): ReviewCleanupResult {
    if (record?.state !== "merged" || cleanup == null || cleanup.startedat < record.startedat) {
        return null;
    }
    return cleanup;
}
