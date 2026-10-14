// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Validate's plan sheet, the pure part (FR-REV-012, DS-REV-010): what the checks and the merge's progress look like,
// and when Merge can be clicked. wavesrv decides again on the click; the sheet only reflects the plan.

import { t } from "../i18n/i18n";
import type { ReviewCleanupResult } from "./review-cleanup";
import { ReviewCheckState, ReviewMergePlan, ReviewMergeRecord, ReviewMergeState } from "./review-client";

const RunningStates: ReviewMergeState[] = ["checking", "updating", "waitingci", "merging"];

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

export const CheckLooks: Record<ReviewCheckState, { icon: string; tone: string; word: string }> = {
    ok: {
        tone: "text-success",
        icon: "fa-circle-check",
        get word() {
            return t("review.merge.check.ok");
        },
    },
    info: {
        tone: "text-accent",
        icon: "fa-circle-info",
        get word() {
            return t("review.merge.check.info");
        },
    },
    warn: {
        tone: "text-warning",
        icon: "fa-triangle-exclamation",
        get word() {
            return t("review.merge.check.warn");
        },
    },
    pending: {
        tone: "text-muted",
        icon: "fa-clock",
        get word() {
            return t("review.merge.check.pending");
        },
    },
    fail: {
        tone: "text-error",
        icon: "fa-circle-xmark",
        get word() {
            return t("review.merge.check.fail");
        },
    },
};

// Merge is clickable when the plan allows it, its warnings are confirmed and no merge of the PR is running (AC4).
export function canClickMerge(plan: ReviewMergePlan, override: boolean, record: ReviewMergeRecord): boolean {
    if (plan == null || !plan.canmerge || mergeRunning(record)) {
        return false;
    }
    return (plan.warnings ?? []).length === 0 || override;
}

// Why Merge is disabled, as its tooltip and the line under the checks say.
export function mergeDisabledReason(plan: ReviewMergePlan, override: boolean, record: ReviewMergeRecord): string {
    if (plan == null) {
        return t("review.merge.reading");
    }
    if (mergeRunning(record)) {
        return t("review.merge.running");
    }
    if (!plan.canmerge) {
        return plan.reason || t("review.merge.checkFails");
    }
    if ((plan.warnings ?? []).length > 0 && !override) {
        return t("review.merge.confirmWarnings");
    }
    return "";
}

export function mergeButtonLabel(plan: ReviewMergePlan): string {
    return plan?.behind ? t("review.merge.updateThenMerge") : t("review.merge.rebaseAndMerge");
}

export function mergeStateLabel(record: ReviewMergeRecord, baseref: string): string {
    switch (record?.state) {
        case "checking":
            return t("review.merge.state.checking");
        case "updating":
            return t("review.merge.state.updating", { base: baseref });
        case "waitingci":
            return t("review.merge.state.waitingci");
        case "merging":
            return t("review.merge.state.merging");
        case "merged":
            return record.message || t("review.merge.state.merged");
        case "refused":
        case "failed":
        case "cancelled":
            return record.message || record.state;
    }
    return "";
}

export function mergeStateTone(state: ReviewMergeState): string {
    switch (state) {
        case "merged":
            return "text-success";
        case "refused":
        case "failed":
            return "text-error";
        case "cancelled":
            return "text-warning";
    }
    return "text-secondary";
}

// The wait can be stopped only before the merge call: GitHub's merge is not undone.
export function canCancelMerge(record: ReviewMergeRecord): boolean {
    return record != null && (record.state === "updating" || record.state === "waitingci");
}

// mergeCleanup is the cleanup the merge ran, from the review store: none before the merge, and never an older run
// (a cleanup started by hand before this merge).
export function mergeCleanup(record: ReviewMergeRecord, cleanup: ReviewCleanupResult): ReviewCleanupResult {
    if (record?.state !== "merged" || cleanup == null || cleanup.startedat < record.startedat) {
        return null;
    }
    return cleanup;
}
