// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The batch merge in the Reviews list (FR-REV-025, DS-REV-017): the selection of the PRs, the confirmation modal (the
// order, the method, what the agent does, the main checkout untouched; Enter starts, Escape cancels), the banner over
// the list while the run goes and once it ended, and each PR's mark on its row. Nothing opens by itself: the agent's
// terminal is reached from the banner's Go to the agent.

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { DialogFrame } from "../dialog-frame";
import { useT, useTCount } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { topModal } from "../modal-focus";
import { showPanel } from "../review/review-panels";
import { DominoLoader } from "../suite/suite";
import { BatchRuns } from "./reviews-batch-client";
import {
    batchActive,
    batchConfirmKey,
    batchCurrent,
    BatchDecision,
    batchDecisionLabel,
    batchDecisions,
    BatchPlan,
    batchPlanCostText,
    BatchRowMark,
    BatchRun,
    batchStepText,
    batchSummary,
    batchTitle,
    methodText,
} from "./reviews-batch-model";

const PlainButton =
    "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-4 border border-border px-2 py-0.5 text-11 leading-5 text-secondary hover:bg-hover hover:text-primary";

const MarkTones: Record<string, string> = {
    success: "border-success/40 bg-success/10 text-success",
    failure: "border-error/40 bg-error/10 text-danger",
    pending: "border-warning/40 bg-warning/10 text-warning",
    neutral: "border-border bg-hover text-muted",
};

function stop(e: React.SyntheticEvent) {
    e.stopPropagation();
}

// The selection bar under the waiting group's heading: how many PRs are selected and the way to the modal.
export function BatchSelectBar({
    count,
    onMerge,
    onCancel,
}: {
    count: number;
    onMerge: () => void;
    onCancel: () => void;
}) {
    const t = useT();
    const tCount = useTCount();
    return (
        <div
            className="flex flex-wrap items-center gap-2 rounded-4 border border-accent/40 bg-accent/5 px-2.5 py-1.5 text-12"
            data-testid="reviews-batch-select"
        >
            <span className="min-w-0 grow text-secondary">{tCount("reviews.batch.select.count", count)}</span>
            <button type="button" className={PlainButton} onClick={onCancel} data-testid="reviews-batch-select-cancel">
                {t("common.cancel")}
            </button>
            <button
                type="button"
                className="molten-btn cursor-pointer rounded-4 px-2.5 py-0.5 text-11"
                aria-disabled={count === 0 || undefined}
                onClick={() => count > 0 && onMerge()}
                title={count === 0 ? t("reviews.batch.select.none") : undefined}
                data-testid="reviews-batch-select-merge"
            >
                {tCount("reviews.batch.select.merge", count)}
                <MoltenWave />
            </button>
        </div>
    );
}

export function BatchCheckbox({ checked, number }: { checked: boolean; number: number }) {
    const t = useT();
    return (
        <span
            role="checkbox"
            aria-checked={checked}
            aria-label={t("reviews.batch.select.rowAria", { number })}
            className={cn(
                "mr-2 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-3 border align-[-2px]",
                checked ? "border-accent bg-accent text-primary" : "border-border bg-transparent"
            )}
            data-testid="reviews-batch-check"
        >
            {checked ? <i className="fa fa-solid fa-check text-10" aria-hidden /> : null}
        </span>
    );
}

export function BatchRowChip({ mark }: { mark: BatchRowMark }) {
    if (mark == null) {
        return null;
    }
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded-4 border px-1.5 py-0.5 text-11 leading-4 whitespace-nowrap",
                MarkTones[mark.tone]
            )}
            title={mark.title}
            data-testid="reviews-batch-mark"
        >
            {mark.current ? <DominoLoader /> : <i className="fa fa-solid fa-layer-group text-10" aria-hidden />}
            {mark.label}
        </span>
    );
}

// The confirmation modal: nothing starts before Start; Enter starts, Escape cancels.
export function BatchConfirmDialog({
    plan,
    base,
    onStart,
    onCancel,
}: {
    plan: BatchPlan;
    base: string;
    onStart: () => Promise<string>;
    onCancel: () => void;
}) {
    const t = useT();
    const tCount = useTCount();
    const startRef = useRef<HTMLButtonElement>(null);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState("");
    const count = plan.steps.length;
    const start = () => {
        if (starting || count === 0) {
            return;
        }
        setStarting(true);
        setError("");
        fireAndForget(async () => {
            const problem = await onStart();
            setStarting(false);
            setError(problem);
        });
    };
    const startRefFn = useRef(start);
    startRefFn.current = start;
    useEffect(() => {
        startRef.current?.focus();
        const onKey = (e: KeyboardEvent) => {
            const dialog = startRef.current?.closest('[role="dialog"]');
            if (dialog == null || topModal() !== dialog) {
                return;
            }
            const answer = batchConfirmKey(e.key);
            if (answer == null || answer === "cancel") {
                return;
            }
            // Another button with the focus (Cancel) answers Enter itself.
            const target = e.target as HTMLElement;
            if (answer === "start" && target?.tagName === "BUTTON" && target !== startRef.current) {
                return;
            }
            e.stopPropagation();
            e.stopImmediatePropagation();
            e.preventDefault();
            startRefFn.current();
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [onCancel]);
    const method = methodText(plan.method);
    return (
        <DialogFrame
            role="reviews-batch-confirm"
            onEscape={onCancel}
            title={tCount("reviews.batch.confirm.title", count)}
            subtitle={t("reviews.batch.confirm.subtitle", { base, method })}
            widthClass="w-[560px]"
            trapFocus
            buttons={
                <>
                    <button
                        type="button"
                        className="cursor-pointer rounded-4 border border-border px-3 py-1 text-12 text-secondary hover:bg-hover hover:text-primary"
                        onClick={onCancel}
                        data-testid="reviews-batch-confirm-cancel"
                    >
                        {t("common.cancel")}
                    </button>
                    <button
                        ref={startRef}
                        type="button"
                        className="molten-btn cursor-pointer rounded-4 px-3 py-1 text-12"
                        aria-busy={starting || undefined}
                        onClick={start}
                        data-testid="reviews-batch-confirm-start"
                    >
                        {starting ? <DominoLoader /> : null}
                        {t("reviews.batch.confirm.start")}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <div className="flex flex-col gap-3 text-12 leading-5" data-testid="reviews-batch-confirm">
                <ol className="flex max-h-56 flex-col overflow-auto rounded-4 border border-border">
                    {plan.steps.map((step) => (
                        <li
                            key={step.pr.number}
                            className="flex items-baseline gap-2 border-b border-border px-2.5 py-1.5 last:border-b-0"
                            data-testid="reviews-batch-confirm-pr"
                            data-pr={step.pr.number}
                        >
                            <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-4 border border-accent/50 bg-accent/10 px-1 text-10 leading-none font-semibold text-accent tabular-nums">
                                {step.rank}
                            </span>
                            <span className="min-w-0">
                                <span className="font-medium text-primary">
                                    #{step.pr.number} {step.pr.tickettitle || step.pr.title}
                                </span>
                                {step.reason ? (
                                    <span className="block truncate text-11 text-secondary">{step.reason}</span>
                                ) : null}
                            </span>
                        </li>
                    ))}
                </ol>
                <p className="text-secondary" data-testid="reviews-batch-confirm-cost">
                    {batchPlanCostText(plan)}
                </p>
                <p className="text-secondary">{t("reviews.batch.confirm.what", { base })}</p>
                <p className="text-secondary">{t("reviews.batch.confirm.stops")}</p>
                <p className="text-muted">{t("reviews.batch.confirm.checkout")}</p>
                {error ? (
                    <p className="text-danger" role="alert" data-testid="reviews-batch-confirm-error">
                        {error}
                    </p>
                ) : null}
            </div>
        </DialogFrame>
    );
}

// The banner over the Reviews list: the dominoes while the run goes, its progress and the PR in progress, Cancel and
// the way to the agent's terminal; the stop with the developer's choices; the summary once it ended.
export function BatchBanner({ run }: { run: BatchRun }) {
    const t = useT();
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");
    const active = batchActive(run);
    const current = batchCurrent(run);
    const paused = run.state === "paused";
    const act = (what: string, fn: () => Promise<unknown>) => {
        if (busy) {
            return;
        }
        setBusy(what);
        setError("");
        fireAndForget(async () => {
            try {
                await fn();
            } catch (e) {
                setError(serverErrorText(e));
            } finally {
                setBusy("");
            }
        });
    };
    const model = BatchRuns.getInstance();
    const tone = paused
        ? "border-warning/50 bg-warning/10"
        : active
          ? "border-accent/40 bg-accent/5"
          : run.state === "done" && run.items.every((it) => it.state === "merged")
            ? "border-success/40 bg-success/10"
            : "border-border bg-hover/40";
    return (
        <div
            className={cn("flex flex-col gap-1.5 rounded-4 border px-3 py-2 text-12 leading-5", tone)}
            role="status"
            aria-live="polite"
            data-testid="reviews-batch-banner"
            data-state={run.state}
        >
            <div className="flex min-w-0 items-center gap-2">
                {active && !paused ? (
                    <DominoLoader className="text-accent" />
                ) : (
                    <i
                        className={cn(
                            "fa fa-solid text-11",
                            paused
                                ? "fa-hand text-warning"
                                : run.state === "done"
                                  ? "fa-layer-group text-success"
                                  : "fa-layer-group text-muted"
                        )}
                        aria-hidden
                    />
                )}
                <span className="min-w-0 grow truncate font-medium text-primary" data-testid="reviews-batch-title">
                    {batchTitle(run)}
                </span>
                {run.blockid && (active || run.kept) ? (
                    <button
                        type="button"
                        className={PlainButton}
                        onClick={() => fireAndForget(() => showPanel(run.blockid))}
                        onKeyDown={stop}
                        title={t("reviews.batch.goToTitle", { name: run.agentname || t("reviews.batch.yourAgent") })}
                        data-testid="reviews-batch-goto"
                    >
                        {t("reviews.batch.goTo")}
                        <i className="fa fa-solid fa-arrow-right text-10" aria-hidden />
                    </button>
                ) : null}
                {active ? (
                    <button
                        type="button"
                        className={PlainButton}
                        aria-disabled={run.cancelasked || undefined}
                        onClick={() => !run.cancelasked && act("cancel", () => model.cancel(run))}
                        title={t("reviews.batch.cancelTitle")}
                        data-testid="reviews-batch-cancel"
                    >
                        {busy === "cancel" ? <DominoLoader /> : null}
                        {run.cancelasked ? t("reviews.batch.cancelling") : t("reviews.batch.cancel")}
                    </button>
                ) : (
                    <button
                        type="button"
                        className={cn(PlainButton, "border-transparent px-1")}
                        onClick={() => act("dismiss", () => model.dismiss(run))}
                        aria-label={t("reviews.batch.dismiss")}
                        title={t("reviews.batch.dismiss")}
                        data-testid="reviews-batch-dismiss"
                    >
                        <i className="fa fa-solid fa-xmark text-11" aria-hidden />
                    </button>
                )}
            </div>
            {active && current != null ? (
                <div
                    className={cn("min-w-0 truncate text-11", paused ? "text-warning" : "text-secondary")}
                    data-testid="reviews-batch-step"
                >
                    <span className="font-medium text-primary">#{current.number}</span>{" "}
                    {current.title ? <span className="text-secondary">{current.title} · </span> : null}
                    {batchStepText(run, current)}
                </div>
            ) : null}
            {paused && current != null ? (
                <div className="flex flex-wrap items-center gap-1.5" data-testid="reviews-batch-decide">
                    <span className="mr-1 text-11 text-secondary">{t("reviews.batch.waitsForYou")}</span>
                    {batchDecisions(current).map((d: BatchDecision) => (
                        <button
                            key={d}
                            type="button"
                            className={cn(
                                d === "retry" || d === "override"
                                    ? "molten-btn cursor-pointer rounded-4 px-2 py-0.5 text-11"
                                    : PlainButton
                            )}
                            onClick={() => act(d, () => model.decide(run, d))}
                            data-testid={`reviews-batch-decide-${d}`}
                        >
                            {busy === d ? <DominoLoader /> : null}
                            {batchDecisionLabel(d)}
                            {d === "retry" || d === "override" ? <MoltenWave /> : null}
                        </button>
                    ))}
                </div>
            ) : null}
            {!active ? (
                <div className="text-11 text-secondary" data-testid="reviews-batch-summary">
                    {batchSummary(run)}
                </div>
            ) : null}
            {error ? (
                <div className="text-11 text-danger" role="alert">
                    {error}
                </div>
            ) : null}
        </div>
    );
}
