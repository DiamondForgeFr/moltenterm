// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The CI/CD state icons (FR-SHELL-057, DS-SHELL-099): 14 px, one shape per state, so a state never rests on its colour
// alone (NFR-SHELL-026): a check, a cross, a spinner, a clock, a minus, and a triangle for a run cut short. The spinner
// steps like every running indicator and stands still under reduced motion (mt-step-spin).

import { cn } from "@/util/util";
import { CiStatus, CiStatusLabels } from "./ci-model";
import { CheckState } from "./github";

export type CiIconState = "success" | "failure" | "running" | "queued" | "neutral" | "warning";

export const CiIconClasses: Record<CiIconState, string> = {
    success: "fa-check text-success",
    failure: "fa-xmark text-error",
    running: "fa-circle-notch fa-spin mt-step-spin text-accent",
    queued: "fa-clock text-muted",
    neutral: "fa-minus text-muted",
    warning: "fa-triangle-exclamation text-warning",
};

export const CiIconLabels: Record<CiIconState, string> = {
    success: "passed",
    failure: "failed",
    running: "running",
    queued: "queued",
    neutral: "skipped or cancelled",
    warning: "needs attention",
};

const LocalStates: Record<CiStatus, CiIconState> = {
    success: "success",
    failure: "failure",
    running: "running",
    queued: "queued",
    cancelled: "neutral",
    interrupted: "warning",
};

const CheckStates: Record<CheckState, CiIconState> = {
    success: "success",
    failure: "failure",
    pending: "running",
    neutral: "neutral",
};

export function localCiIconState(status: CiStatus): CiIconState {
    return LocalStates[status] ?? "neutral";
}

export function checkIconState(state: CheckState): CiIconState {
    return CheckStates[state] ?? "neutral";
}

// A GitHub Actions run: waiting to start and running apart, which CheckState folds into one "pending".
export function githubRunIconState(status: string, conclusion: string): CiIconState {
    const s = (status ?? "").toLowerCase();
    if (s === "in_progress") {
        return "running";
    }
    if (s === "queued" || s === "waiting" || s === "requested" || s === "pending") {
        return "queued";
    }
    switch ((conclusion ?? "").toLowerCase()) {
        case "success":
            return "success";
        case "failure":
        case "timed_out":
        case "startup_failure":
            return "failure";
        case "action_required":
            return "warning";
    }
    return "neutral";
}

export function CiIcon({ state, label, className }: { state: CiIconState; label?: string; className?: string }) {
    const text = label ?? CiIconLabels[state];
    return (
        <i
            className={cn(
                "fa fa-solid inline-block w-3.5 shrink-0 text-center text-icon-14",
                CiIconClasses[state],
                className
            )}
            role="img"
            aria-label={text}
            title={text}
            data-state={state}
        />
    );
}

export function LocalCiIcon({ status }: { status: CiStatus }) {
    return <CiIcon state={localCiIconState(status)} label={CiStatusLabels[status]} />;
}
