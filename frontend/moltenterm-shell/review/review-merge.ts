// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Validate's plan sheet, the pure part (FR-REV-012, DS-REV-010): what the checks and the merge's progress look like,
// and when Merge can be clicked. wavesrv decides again on the click; the sheet only reflects the plan.

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
    ok: { tone: "text-success", icon: "fa-circle-check", word: "Passed" },
    info: { tone: "text-accent", icon: "fa-circle-info", word: "Note" },
    warn: { tone: "text-warning", icon: "fa-triangle-exclamation", word: "Warning" },
    pending: { tone: "text-muted", icon: "fa-clock", word: "Waiting" },
    fail: { tone: "text-error", icon: "fa-circle-xmark", word: "Failed" },
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
        return "Reading the pull request…";
    }
    if (mergeRunning(record)) {
        return "A merge of this pull request is running";
    }
    if (!plan.canmerge) {
        return plan.reason || "A check does not pass";
    }
    if ((plan.warnings ?? []).length > 0 && !override) {
        return "Confirm the warnings to merge anyway";
    }
    return "";
}

export function mergeButtonLabel(plan: ReviewMergePlan): string {
    return plan?.behind ? "Update, then merge" : "Rebase and merge";
}

export function mergeStateLabel(record: ReviewMergeRecord, baseref: string): string {
    switch (record?.state) {
        case "checking":
            return "Reading the pull request again…";
        case "updating":
            return `GitHub is rebasing the branch on ${baseref}…`;
        case "waitingci":
            return "Waiting for CI on the rebased head…";
        case "merging":
            return "Merging…";
        case "merged":
            return record.message || "Merged";
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
