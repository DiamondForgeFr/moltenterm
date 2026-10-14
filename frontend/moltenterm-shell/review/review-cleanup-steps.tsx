// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The steps of the cleanup after a merge (FR-REV-013 AC5), for the Validate sheet: each one done, skipped with its
// reason or failed with its message, the other PRs under their step, and the agent worktree's second confirmation.

import { cn } from "@/util/util";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import {
    cleanupNeedsConfirmation,
    cleanupPrDetail,
    cleanupStepDetail,
    cleanupStepLabel,
    ReviewCleanupStepResult,
    ReviewCleanupStepState,
    ReviewWorktreeRisk,
} from "./review-cleanup";

const StateIcons: Record<ReviewCleanupStepState, string> = {
    planned: "fa-regular fa-circle text-muted",
    done: "fa-solid fa-circle-check text-success",
    skipped: "fa-solid fa-circle-minus text-secondary",
    failed: "fa-solid fa-circle-xmark text-error",
};

const DangerButton = "molten-btn molten-btn-destructive cursor-pointer rounded-6 px-3 py-1.5 text-12";

type CleanupStepsProps = {
    // The plan's steps (planned) or a cleanup's outcome.
    steps: ReviewCleanupStepResult[];
    // Called with the risk of the plan shown when the developer confirms removing the agent worktree.
    onConfirmWorktree?: (risk: ReviewWorktreeRisk) => void;
    busy?: boolean;
};

export function CleanupSteps({ steps, onConfirmWorktree, busy }: CleanupStepsProps) {
    const t = useT();
    if (steps == null) {
        return null;
    }
    const pending = cleanupNeedsConfirmation(steps);
    const stateWord = (state: string) => t(`review.cleanup.state.${state}`);
    return (
        <div className="flex flex-col gap-1.5 text-12" data-testid="review-cleanup-steps">
            {steps.map((step) => (
                <div key={step.id} className="flex flex-col" data-step={step.id} data-state={step.state}>
                    <div className="flex items-center gap-2">
                        <i className={cn(StateIcons[step.state], "w-4 text-center")} title={stateWord(step.state)} />
                        <span className={cn(step.state === "skipped" && "text-secondary")}>
                            {cleanupStepLabel(step.id)}
                        </span>
                        {step.state !== "planned" && <span className="text-secondary">· {stateWord(step.state)}</span>}
                    </div>
                    {cleanupStepDetail(step) !== "" && (
                        <div
                            className={cn(
                                "ml-6 break-words",
                                step.state === "failed" ? "text-error" : "text-secondary"
                            )}
                        >
                            {cleanupStepDetail(step)}
                        </div>
                    )}
                    {step.prs?.map((pr) => (
                        <div key={pr.number} className="ml-6 flex items-center gap-2" data-pr={pr.number}>
                            <i className={cn(StateIcons[pr.state], "w-4 text-center")} title={stateWord(pr.state)} />
                            <span>#{pr.number}</span>
                            <span className="truncate text-secondary">{pr.branch}</span>
                            <span className={cn(pr.state === "failed" ? "text-error" : "text-secondary")}>
                                {cleanupPrDetail(pr)}
                            </span>
                        </div>
                    ))}
                </div>
            ))}
            {pending != null && onConfirmWorktree != null && (
                <div className="mt-1 flex items-center gap-2">
                    <button className={DangerButton} disabled={busy} onClick={() => onConfirmWorktree(pending.confirm)}>
                        {t("review.cleanup.removeAgentWorktree")}
                        <MoltenWave />
                    </button>
                </div>
            )}
        </div>
    );
}
