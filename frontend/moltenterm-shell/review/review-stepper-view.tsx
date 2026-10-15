// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Validate's stepper (#672): the steps in the order they happen, drawn like the local build panel's phases (FR-MC-013)
// standing upright, each with its state and what it will do or did underneath. A kept worktree shows what removing it
// would lose and the panels still working in it, one destructive button that names what it does, Show the panel and
// Show in folder.

import { getApi, openLink } from "@/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useState } from "react";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { ReviewCleanupStepResult } from "./review-cleanup";
import { showPanel } from "./review-panels";
import { keptButtonLabel, panelName, StepRow, StepState, ValidateStep } from "./review-stepper";

const NodeClasses: Record<StepState, string> = {
    todo: "border-border bg-transparent text-muted",
    running: "border-accent/70 bg-accent/15 text-accent",
    done: "border-success/60 bg-success/10 text-success",
    skipped: "border-border bg-transparent text-muted",
    needs: "border-warning/70 bg-warning/10 text-warning",
    failed: "border-error/60 bg-error/10 text-error",
};

const RowTones: Record<StepState, string> = {
    todo: "text-muted",
    running: "text-accent",
    done: "text-success",
    skipped: "text-muted",
    needs: "text-warning",
    failed: "text-error",
};

const PlainButton =
    "cursor-pointer rounded-4 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

function StateIcon({ state, small }: { state: StepState; small?: boolean }) {
    const size = small ? "text-10" : "text-11";
    switch (state) {
        case "done":
            return <i className={cn("fa fa-solid fa-check", size)} />;
        case "failed":
            return <i className={cn("fa fa-solid fa-xmark", size)} />;
        case "running":
            return <i className={cn("fa fa-solid fa-circle-notch fa-spin mt-step-spin", size)} />;
        case "needs":
            return <i className={cn("fa fa-solid fa-exclamation", size)} />;
        case "skipped":
            return <i className={cn("fa fa-solid fa-minus", size)} />;
    }
    return <span className="h-1.5 w-1.5 rounded-full bg-current" />;
}

function ErrorText({ error }: { error: string }) {
    if (!error) {
        return null;
    }
    return (
        <pre className="mt-1 max-h-24 overflow-auto rounded-4 border border-error/30 bg-error/5 px-2 py-1 font-mono text-11 whitespace-pre-wrap break-words text-error">
            {error}
        </pre>
    );
}

function Row({ row }: { row: StepRow }) {
    const t = useT();
    return (
        <div className="flex items-start gap-2" data-row={row.id} data-state={row.state}>
            <span
                className={cn("mt-0.5 flex w-3.5 justify-center", RowTones[row.state])}
                title={t(`review.validate.state.${row.state}`)}
            >
                <StateIcon state={row.state} small />
            </span>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className={cn(row.state === "skipped" ? "text-secondary" : "text-primary")}>{row.label}</span>
                    {row.url ? (
                        <button
                            type="button"
                            className="cursor-pointer text-11 text-accent hover:underline"
                            onClick={() => fireAndForget(() => openLink(row.url))}
                        >
                            {t("review.validate.others.open")}
                        </button>
                    ) : null}
                </div>
                {row.lines.map((line, i) => (
                    <div
                        key={i}
                        className={cn("break-words", row.state === "failed" ? "text-error" : "text-secondary")}
                    >
                        {line}
                    </div>
                ))}
                <ErrorText error={row.error} />
            </div>
        </div>
    );
}

type KeptActions = {
    // The worktrees the cleanup kept: for work removing would lose, or for panels still open in them.
    steps: ReviewCleanupStepResult[];
    busy?: boolean;
    onRemove?: (step: ReviewCleanupStepResult) => void;
};

// canRemoveKept: the agent worktree can always be removed on the developer's choice; the review worktree only once its
// panels are closed, never with changes in it (the sheet names them).
function canRemoveKept(step: ReviewCleanupStepResult): boolean {
    if (step.id === "agent-worktree") {
        return step.confirm != null;
    }
    return step.code === "inuse" && (step.panels?.length ?? 0) > 0;
}

function KeptStepButtons({ step, actions }: { step: ReviewCleanupStepResult; actions: KeptActions }) {
    const t = useT();
    const panels = step.panels ?? [];
    return (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-testid={`validate-kept-${step.id}`}>
            {canRemoveKept(step) && actions.onRemove != null ? (
                <button
                    type="button"
                    className="molten-btn molten-btn-destructive cursor-pointer rounded-4 px-3 py-1.5 text-12 disabled:cursor-default disabled:opacity-50"
                    disabled={actions.busy}
                    onClick={() => actions.onRemove(step)}
                    data-testid={`validate-remove-${step.id}`}
                >
                    {keptButtonLabel(t, step)}
                    <MoltenWave />
                </button>
            ) : null}
            {panels.map((p) => (
                <button
                    key={p.blockid}
                    type="button"
                    className={PlainButton}
                    onClick={() => fireAndForget(() => showPanel(p.blockid))}
                    data-testid="validate-show-panel"
                >
                    {panels.length === 1
                        ? t("review.validate.panels.show")
                        : t("review.validate.panels.showNamed", { panel: panelName(t, p) })}
                </button>
            ))}
            {step.path ? (
                <button
                    type="button"
                    className={PlainButton}
                    title={step.path}
                    onClick={() => getApi().openNativePath(step.path)}
                    data-testid={`validate-show-${step.id}`}
                >
                    <i className="fa fa-solid fa-folder-open mr-1 text-11" />
                    {step.id === "review-worktree"
                        ? t("review.validate.showReviewFolder")
                        : t("review.validate.showFolder")}
                </button>
            ) : null}
        </div>
    );
}

function KeptButtons({ actions }: { actions: KeptActions }) {
    const steps = (actions.steps ?? []).filter((s) => s != null);
    if (steps.length === 0) {
        return null;
    }
    return (
        <div data-testid="validate-kept-actions">
            {steps.map((s) => (
                <KeptStepButtons key={s.id} step={s} actions={actions} />
            ))}
        </div>
    );
}

function StepItem({
    step,
    last,
    top,
    extra,
}: {
    step: ValidateStep;
    last: boolean;
    top?: React.ReactNode;
    extra?: React.ReactNode;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const showRows = step.rows.length > 0 && (!step.collapsed || open);
    return (
        <li
            className="relative flex gap-3 pb-4 last:pb-0"
            data-testid={`validate-step-${step.id}`}
            data-state={step.state}
        >
            {!last ? <span className="absolute top-8 bottom-0 left-[13px] w-px bg-border" aria-hidden /> : null}
            <span
                className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border",
                    NodeClasses[step.state]
                )}
                data-status={step.state}
            >
                <StateIcon state={step.state} />
            </span>
            <div className="min-w-0 flex-1 pt-1">
                <div className="flex items-center gap-2">
                    <span
                        className={cn(
                            "text-13 leading-5 font-medium",
                            step.state === "skipped" ? "text-secondary" : "text-primary"
                        )}
                    >
                        {step.title}
                    </span>
                    <span className={cn("text-11 tracking-wide uppercase", RowTones[step.state])}>
                        {t(`review.validate.state.${step.state}`)}
                    </span>
                </div>
                {top}
                {step.lines.map((line, i) => (
                    <div key={i} className="break-words text-secondary">
                        {line}
                        {i === 0 && step.collapsed ? (
                            <button
                                type="button"
                                className="ml-2 cursor-pointer text-11 text-accent hover:underline"
                                onClick={() => setOpen(!open)}
                                data-testid="validate-checks-toggle"
                            >
                                {open ? t("review.validate.checks.hide") : t("review.validate.checks.show")}
                            </button>
                        ) : null}
                    </div>
                ))}
                <ErrorText error={step.error} />
                {showRows ? (
                    <div className="mt-1.5 flex flex-col gap-1.5">
                        {step.rows.map((row) => (
                            <Row key={row.id} row={row} />
                        ))}
                    </div>
                ) : null}
                {extra}
            </div>
        </li>
    );
}

export function ValidateStepper({
    steps,
    checksExtra,
    mergeTop,
    kept,
}: {
    steps: ValidateStep[];
    // Under the checks: the confirmation of their warnings.
    checksExtra?: React.ReactNode;
    // Under the merge step's title: the choice of the merge method (#673).
    mergeTop?: React.ReactNode;
    kept?: KeptActions;
}) {
    const t = useT();
    return (
        <ol className="flex flex-col" aria-label={t("review.validate.stepsLabel")} data-testid="validate-stepper">
            {steps.map((step, i) => (
                <StepItem
                    key={step.id}
                    step={step}
                    last={i === steps.length - 1}
                    top={step.id === "merge" ? mergeTop : null}
                    extra={
                        step.id === "checks" ? (
                            checksExtra
                        ) : step.id === "cleanup" && kept ? (
                            <KeptButtons actions={kept} />
                        ) : null
                    }
                />
            ))}
        </ol>
    );
}
