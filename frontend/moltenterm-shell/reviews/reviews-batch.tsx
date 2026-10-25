// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The batch merge and the merge queue in the Reviews list (FR-REV-025, FR-REV-026, DS-REV-017): the confirmation
// modal, opened from the merge queue's Merge in this order (#1062), (the order, the method, what the agent does, the main checkout untouched; Enter adds them
// to the queue, Escape cancels), the banner over the list while the queue runs and once it ended, and each PR's mark on
// its row. Nothing opens by itself: the agent's terminal is reached from the banner's Go to the agent.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { AgentStates } from "../agent-state-store";
import { DialogFrame } from "../dialog-frame";
import { useLocale, useT, useTCount } from "../i18n/i18n";
import { errorPhrase, Phrase, useWordPhrase } from "../i18n/phrase";
import { topModal } from "../modal-focus";
import { MoltenWave } from "../molten-button";
import { MergeMethodPicker } from "../review/merge-method-picker";
import { ReviewMergeMethod, ReviewMergeMethods, reviewMergeMethods } from "../review/review-client";
import { showPanel } from "../review/review-panels";
import { DominoLoader } from "../suite/suite";
import { BatchRuns } from "./reviews-batch-client";
import {
    batchActive,
    batchConfirmKey,
    batchCurrent,
    batchHeadline,
    batchItemEnded,
    batchItemId,
    batchMethodShown,
    BatchPlan,
    batchPlanCostText,
    BatchRowMark,
    batchRowMark,
    BatchRun,
    batchStepText,
    batchSummary,
    batchTitle,
    canWithdraw,
    methodText,
    ShownIds,
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
    dir,
    repo,
    base,
    onStart,
    onCancel,
}: {
    plan: BatchPlan;
    dir: string;
    repo: string;
    base: string;
    onStart: (method: ReviewMergeMethod) => Promise<Phrase>;
    onCancel: () => void;
}) {
    const t = useT();
    const word = useWordPhrase();
    const tCount = useTCount();
    const startRef = useRef<HTMLButtonElement>(null);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState<Phrase>(null);
    // The method (#957): Validate's, read fresh for the repository's base, the developer's pick over it; nothing starts
    // before it is known, so the queue never decides it at merge time.
    const [methods, setMethods] = useState<ReviewMergeMethods>(null);
    const [methodsError, setMethodsError] = useState<Phrase>(null);
    const [picked, setPicked] = useState<ReviewMergeMethod>(null);
    useEffect(() => {
        let live = true;
        reviewMergeMethods(dir, repo, base).then(
            (answer) => live && setMethods(answer),
            (e) => live && setMethodsError(errorPhrase(e))
        );
        return () => {
            live = false;
        };
    }, [dir, repo, base]);
    const method = batchMethodShown(methods, picked);
    const count = plan.steps.length;
    const start = () => {
        if (starting || count === 0 || method == null) {
            return;
        }
        setStarting(true);
        setError(null);
        fireAndForget(async () => {
            const problem = await onStart(method);
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
    const methodLabel = methodText(method ?? "");
    return (
        <DialogFrame
            role="reviews-batch-confirm"
            onEscape={onCancel}
            title={tCount("reviews.batch.confirm.title", count)}
            subtitle={t("reviews.batch.confirm.subtitle", { base, method: methodLabel })}
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
                        aria-disabled={method == null || undefined}
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
                                    #{step.pr.ticket || step.pr.number} {step.pr.tickettitle || step.pr.title}
                                </span>
                                {step.pr.ticket ? (
                                    <span className="ml-1.5 text-11 text-muted">
                                        {t("reviews.card.prChip", { number: step.pr.number })}
                                    </span>
                                ) : null}
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
                {methods != null && method != null ? (
                    <MergeMethodPicker
                        methods={methods.methods}
                        defaultMethod={methods.method}
                        method={method}
                        refused={methods.methodrefused}
                        queue={methods.queue}
                        onSelect={setPicked}
                        testId="reviews-batch-confirm-method"
                    />
                ) : methodsError != null ? (
                    <p className="text-danger" role="alert" data-testid="reviews-batch-confirm-method-error">
                        {t("reviews.batch.confirm.methodError", { detail: word(methodsError) })}
                    </p>
                ) : (
                    <p
                        className="flex items-center gap-2 text-muted"
                        data-testid="reviews-batch-confirm-method-loading"
                    >
                        <DominoLoader />
                        {t("reviews.batch.confirm.methodLoading")}
                    </p>
                )}
                <p className="text-secondary">{t("reviews.batch.confirm.what", { base })}</p>
                <p className="text-secondary">{t("reviews.batch.confirm.stops")}</p>
                <p className="text-muted">{t("reviews.batch.confirm.checkout")}</p>
                {error != null ? (
                    <p className="text-danger" role="alert" data-testid="reviews-batch-confirm-error">
                        {word(error)}
                    </p>
                ) : null}
            </div>
        </DialogFrame>
    );
}

// The banner in the Reviews list's "Agents on it" section (FR-REV-026 AC7, #1123): who works on the queue and its PRs
// in order, the dominoes while it runs, its progress and the PR in progress, each validated PR with its place and
// Cancel validation until its merge starts, Stop and the way to the agent's terminal; the summary once it ended, until
// Hide.
// ids: the number each PR's card shows (#1108), by PR number.
export function BatchBanner({ run, ids }: { run: BatchRun; ids?: ShownIds }) {
    const t = useT();
    useLocale();
    const word = useWordPhrase();
    const agents = useAtomValue(AgentStates.getInstance().dataAtom);
    const [busy, setBusy] = useState("");
    const [error, setError] = useState<Phrase>(null);
    const active = batchActive(run);
    const current = batchCurrent(run);
    // The agent's terminal still open: an ended queue whose agent stays (its copy kept) is reached from here too.
    const agent = run.blockid ? agents.states[run.blockid] : null;
    const act = (what: string, fn: () => Promise<unknown>) => {
        if (busy) {
            return;
        }
        setBusy(what);
        setError(null);
        fireAndForget(async () => {
            try {
                await fn();
            } catch (e) {
                setError(errorPhrase(e));
            } finally {
                setBusy("");
            }
        });
    };
    const model = BatchRuns.getInstance();
    const needsYou = run.items.some((it) => it.state === "failed" || it.waiting);
    const tone = needsYou
        ? "border-warning/50 bg-warning/10"
        : active
          ? "border-accent/40 bg-accent/5"
          : run.state === "done" && run.items.every((it) => it.state === "merged")
            ? "border-success/40 bg-success/10"
            : "border-border bg-hover/40";
    const open = active ? run.items.filter((it) => !batchItemEnded(it)) : [];
    return (
        <div
            className={cn("flex flex-col gap-1.5 rounded-4 border px-3 py-2 text-12 leading-5", tone)}
            role="status"
            aria-live="polite"
            data-testid="reviews-batch-banner"
            data-state={run.state}
        >
            <div className="flex min-w-0 items-center gap-2">
                {active && current != null ? (
                    <DominoLoader className="text-accent" />
                ) : (
                    <i
                        className={cn(
                            "fa fa-solid fa-layer-group text-11",
                            run.state === "done" ? "text-success" : active ? "text-accent" : "text-muted"
                        )}
                        aria-hidden
                    />
                )}
                <span className="min-w-0 grow truncate font-medium text-primary" data-testid="reviews-batch-headline">
                    {batchHeadline(run, agent?.firstname, ids)}
                </span>
                {run.blockid && (active || run.kept || agent != null) ? (
                    <button
                        type="button"
                        className={PlainButton}
                        onClick={() => fireAndForget(() => showPanel(run.blockid))}
                        onKeyDown={stop}
                        title={t("reviews.batch.goToTitle", {
                            name: agent?.firstname || run.agentname || t("reviews.batch.yourAgent"),
                        })}
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
            <div className="text-11 text-secondary" data-testid="reviews-batch-title">
                {batchTitle(run, ids)}
            </div>
            {active && run.resumedat ? (
                <div className="text-11 text-secondary" data-testid="reviews-batch-resumed">
                    {t("reviews.batch.resumed")}
                </div>
            ) : null}
            {open.length > 0 ? (
                <ol className="flex flex-col" data-testid="reviews-batch-list">
                    {open.map((it) => {
                        const mark = batchRowMark(run, it.number);
                        return (
                            <li
                                key={it.number}
                                className="flex min-w-0 items-center gap-2 py-0.5 text-11"
                                data-testid="reviews-batch-item"
                                data-pr={it.number}
                                data-state={it.state}
                            >
                                <span className="shrink-0 font-medium text-primary">#{batchItemId(it, ids)}</span>
                                <span className="min-w-0 grow truncate text-secondary" title={mark?.title}>
                                    {it.title ? `${it.title} · ` : ""}
                                    {it === current ? batchStepText(run, it, agent?.firstname) : mark?.label}
                                </span>
                                {canWithdraw(it) ? (
                                    <button
                                        type="button"
                                        className={PlainButton}
                                        onClick={() =>
                                            act(`withdraw:${it.number}`, () => model.withdraw(run, it.number))
                                        }
                                        onKeyDown={stop}
                                        title={t("reviews.batch.withdrawTitle", { number: batchItemId(it, ids) })}
                                        data-testid="reviews-batch-withdraw"
                                    >
                                        {busy === `withdraw:${it.number}` ? <DominoLoader /> : null}
                                        {t("reviews.batch.withdraw")}
                                    </button>
                                ) : null}
                            </li>
                        );
                    })}
                </ol>
            ) : null}
            {!active ? (
                <div className="text-11 text-secondary" data-testid="reviews-batch-summary">
                    {batchSummary(run, ids)}
                </div>
            ) : null}
            {error != null ? (
                <div className="text-11 text-danger" role="alert">
                    {word(error)}
                </div>
            ) : null}
        </div>
    );
}

// The pointer a hidden, finished queue leaves in "Agents on it" while its agent's session is open (#1128,
// FR-REV-026 AC13): one line with Go there; it goes with the session.
export function BatchPointer({ run, ids }: { run: BatchRun; ids?: ShownIds }) {
    const t = useT();
    useLocale();
    const agents = useAtomValue(AgentStates.getInstance().dataAtom);
    const agent = run.blockid ? agents.states[run.blockid] : null;
    const name = agent?.firstname || run.agentname || t("reviews.batch.yourAgent");
    return (
        <div
            className="flex min-w-0 items-center gap-2 rounded-4 border border-border px-3 py-1.5 text-11 leading-5 text-secondary"
            data-testid="reviews-batch-pointer"
        >
            <i className="fa fa-solid fa-layer-group text-11 text-muted" aria-hidden />
            <span className="min-w-0 grow truncate">
                <span className="font-medium text-primary">{batchHeadline(run, agent?.firstname, ids)}</span>
                {" · "}
                {t("reviews.batch.pointer.ended")}
            </span>
            <button
                type="button"
                className={PlainButton}
                onClick={() => fireAndForget(() => showPanel(run.blockid))}
                onKeyDown={stop}
                title={t("reviews.batch.goToTitle", { name })}
                data-testid="reviews-batch-pointer-goto"
            >
                {t("reviews.batch.goTo")}
                <i className="fa fa-solid fa-arrow-right text-10" aria-hidden />
            </button>
        </div>
    );
}
