// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews merge queue (#1062, FR-REV-024, FR-REV-025): the numbered queue at the top of "Yours", readable without
// hovering (rank, ⟲ rebased by your agent, ◔ waits for its CI), its cost in rebases, a legend for the marks shown and
// the PRs left out, and "Merge in this order…" at the bottom right, after the steps (developer decision 2026-10-24);
// the status line after a merge; and a card's task queued for a busy agent (FR-REV-022 AC12). The data is
// reviews-queue-model.ts's and reviews-ask-queue.ts's.

import { cn } from "@/util/util";
import { useT } from "../i18n/i18n";
import { useWordPhrase } from "../i18n/phrase";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import { QueuedAsk, ReviewsAskQueue } from "./reviews-ask-queue";
import { ForecastStatusLine } from "./reviews-forecast";
import type { ForecastStatus } from "./reviews-forecast-model";
import type { ReviewPr } from "./reviews-model";
import { AfterMerge, afterMergeText, MergeQueue, queueCost, queueLegend } from "./reviews-queue-model";

const SmallButton =
    "flex shrink-0 cursor-pointer items-center rounded-4 border border-border px-2 py-0.5 text-11 leading-4 text-secondary hover:bg-hover hover:text-primary";

function stop(e: React.SyntheticEvent) {
    e.stopPropagation();
}

export function MergeQueueBlock({
    queue,
    prs,
    base,
    status,
    hot,
    canMerge,
    onStep,
    onMerge,
}: {
    queue: MergeQueue;
    prs: readonly ReviewPr[];
    base: string;
    status: ForecastStatus;
    // The steps related to the hovered or focused card, lit.
    hot: readonly number[];
    // Merge in this order is offered: no merge queue runs already over these PRs.
    canMerge: boolean;
    onStep: (number: number) => void;
    onMerge: () => void;
}) {
    const t = useT();
    const word = useWordPhrase();
    const cost = word(queueCost(queue));
    const legend = word(queueLegend(queue, base));
    const titleOf = (n: number) =>
        prs.find((pr) => pr.number === n)?.tickettitle ?? prs.find((pr) => pr.number === n)?.title ?? "";
    return (
        <div
            role="group"
            aria-label={t("reviews.queue.aria")}
            className="grid gap-1.5 rounded-4 border border-[var(--mt-line-2)] bg-[var(--mt-surface-2)] px-2.5 py-2"
            onKeyDown={stop}
            data-testid="reviews-queue"
        >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-12">
                <b className="font-semibold">{t("reviews.queue.title")}</b>
                {cost ? (
                    <span
                        className="text-11 text-muted"
                        title={t("reviews.queue.cost.title")}
                        data-testid="reviews-queue-cost"
                    >
                        {cost}
                    </span>
                ) : null}
                {status != null && status.kind !== "ready" ? <ForecastStatusLine status={status} /> : null}
            </div>
            <ol className="flex flex-wrap items-center gap-1 text-11" data-testid="reviews-queue-steps">
                {queue.steps.map((s, i) => {
                    const marks = [
                        s.rebase ? t("reviews.queue.stepRebase") : "",
                        s.wait ? t("reviews.queue.stepWait") : "",
                    ]
                        .filter(Boolean)
                        .join(", ");
                    const title = s.merged
                        ? t("reviews.queue.stepMerged", { number: s.number })
                        : [
                              t("reviews.queue.stepTitle", {
                                  rank: s.rank,
                                  number: s.number,
                                  title: titleOf(s.number),
                              }),
                              marks,
                          ]
                              .filter(Boolean)
                              .join(" · ");
                    const next = queue.steps[i + 1];
                    return (
                        <li key={s.number} className="flex items-center gap-1">
                            <button
                                type="button"
                                onClick={() => !s.merged && onStep(s.number)}
                                title={title}
                                aria-label={title}
                                className={cn(
                                    "inline-flex cursor-pointer items-center gap-1 rounded-3 border border-[var(--mt-line-2)] px-1.5 leading-4 whitespace-nowrap text-secondary hover:text-primary",
                                    s.rebase && "border-dashed",
                                    s.wait && "text-muted",
                                    s.merged && "line-through opacity-55",
                                    hot.includes(s.number) &&
                                        !s.merged &&
                                        "border-[var(--mt-state-waiting)] bg-[color-mix(in_srgb,var(--mt-state-waiting)_10%,transparent)] text-primary"
                                )}
                                data-testid="reviews-queue-step"
                                data-step={s.number}
                                data-merged={s.merged || undefined}
                                data-hot={hot.includes(s.number) || undefined}
                            >
                                <span className="font-semibold text-accent tabular-nums">
                                    {s.merged ? "✓" : s.rank}
                                </span>
                                #{s.number}
                                {s.rebase ? <span aria-hidden>⟲</span> : null}
                                {s.wait ? <span aria-hidden>◔</span> : null}
                            </button>
                            {next != null ? (
                                <span className="text-10 text-muted" aria-hidden>
                                    {s.merged && !next.merged ? "·" : "→"}
                                </span>
                            ) : null}
                        </li>
                    );
                })}
            </ol>
            {legend ? (
                <div className="text-11 text-muted" data-testid="reviews-queue-legend">
                    {legend}
                </div>
            ) : null}
            {canMerge ? (
                <div className="flex justify-end pt-0.5">
                    <button
                        type="button"
                        onClick={onMerge}
                        title={t("reviews.queue.mergeTitle")}
                        className="molten-btn flex h-[26px] cursor-pointer items-center gap-1.5 rounded-6 px-2.5 text-12"
                        data-testid="reviews-queue-merge"
                    >
                        {t("reviews.queue.merge")}
                        <MoltenWave />
                    </button>
                </div>
            ) : null}
        </div>
    );
}

// The status line after a merge (FR-REV-024): what changed and the next step; nothing starts without the click.
export function AfterMergeLine({
    after,
    busy,
    onHandOver,
    onClose,
}: {
    after: AfterMerge;
    busy: boolean;
    onHandOver: () => void;
    onClose: () => void;
}) {
    const t = useT();
    const word = useWordPhrase();
    if (after == null) {
        return null;
    }
    return (
        <div
            role="status"
            aria-label={t("reviews.queue.after.aria")}
            className="flex flex-wrap items-center gap-2 rounded-r-4 border-l-[3px] border-[var(--mt-state-done)] bg-[color-mix(in_srgb,var(--mt-state-done)_8%,transparent)] px-2.5 py-1.5 text-12 text-secondary"
            onKeyDown={stop}
            data-testid="reviews-after-merge"
        >
            <span className="min-w-0 flex-1">{word(afterMergeText(after))}</span>
            {after.needs.length > 0 ? (
                <>
                    <button
                        type="button"
                        onClick={onHandOver}
                        aria-busy={busy || undefined}
                        title={t("reviews.queue.after.handOverTitle")}
                        className={SmallButton}
                        data-testid="reviews-after-merge-handover"
                    >
                        {busy ? <DominoLoader /> : null}
                        {t("reviews.queue.after.handOver")}
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className={SmallButton}
                        data-testid="reviews-after-merge-later"
                    >
                        {t("reviews.queue.after.later")}
                    </button>
                </>
            ) : (
                <button type="button" onClick={onClose} className={SmallButton} data-testid="reviews-after-merge-later">
                    {t("reviews.queue.after.close")}
                </button>
            )}
        </div>
    );
}

// A card's task waiting for its busy agent (FR-REV-022 AC12): queued with Cancel, being handed, or why it stopped.
export function QueuedAskLine({ ask }: { ask: QueuedAsk }) {
    const t = useT();
    const word = useWordPhrase();
    if (ask == null) {
        return null;
    }
    const queue = ReviewsAskQueue.getInstance();
    const name = ask.agent.name;
    let text: string;
    if (ask.failed != null) {
        text = word(ask.failed);
    } else if (ask.sending) {
        text = t("reviews.queue.ask.sending", { name });
    } else {
        text = t(`reviews.queue.ask.queued.${ask.kind}`, { name });
    }
    return (
        <div
            className={cn(
                "flex flex-wrap items-center gap-2 text-12 leading-4",
                ask.failed != null ? "text-danger" : "text-secondary"
            )}
            role="status"
            onClick={stop}
            onKeyDown={stop}
            data-testid="reviews-queued-ask"
            data-state={ask.failed != null ? "failed" : ask.sending ? "sending" : "queued"}
        >
            {ask.sending ? <DominoLoader /> : <i className="fa fa-regular fa-clock text-11" aria-hidden />}
            <span className="min-w-0">{text}</span>
            {!ask.sending ? (
                <button
                    type="button"
                    onClick={() => queue.cancel(ask.dir, ask.pr.number)}
                    className={SmallButton}
                    data-testid="reviews-queued-ask-cancel"
                >
                    {ask.failed != null ? t("reviews.queue.ask.dismiss") : t("reviews.queue.ask.cancel")}
                </button>
            ) : null}
        </div>
    );
}
