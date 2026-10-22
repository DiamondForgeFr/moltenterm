// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's Recently merged section (#843), last in the panel: a merged PR leaves the review list, and this
// says it merged, when, by whom and where it ships. A row opens the PR on GitHub; its notes chip shows the review
// notes kept on it in the Notes section. Its last line opens the whole merged history (#960, FR-REV-030).

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { lazy, Suspense, useMemo, useState } from "react";
import { useT } from "../i18n/i18n";
import { formatWhen, timeAgo } from "../mission/time-format";
import { openWebLink } from "../open-web-link";
import { useReviewNotes } from "../review/review-notes";
import { PrSignature } from "./pr-signature";
import { MergedDays, MergedOpenPref, notesByPr, ReviewMergedPr, shipsLabel } from "./reviews-merged-model";
import type { ReviewsAnswer } from "./reviews-model";

// The merged history (#960) loads on its first opening: most views never open it.
const MergedHistoryWindow = lazy(() =>
    import("./merged-history-window").then((m) => ({ default: m.MergedHistoryWindow }))
);

const Chip = "inline-flex items-center gap-1 rounded-4 border px-1.5 py-0.5 text-11 leading-4 whitespace-nowrap";

const ShipsClasses = {
    success: "border-success/40 bg-success/10 text-success",
    neutral: "border-border bg-hover text-muted",
};

export function MergedSection({
    answer,
    onShowNotes,
}: {
    answer: ReviewsAnswer;
    onShowNotes: (filter: string) => void;
}) {
    const t = useT();
    const pref = MergedOpenPref.getInstance();
    const open = useAtomValue(pref.openAtom);
    const { notes } = useReviewNotes(answer.repo);
    const noteCounts = useMemo(() => notesByPr(notes?.notes), [notes]);
    const merged = answer.merged ?? [];
    const [historyOpen, setHistoryOpen] = useState(false);
    return (
        <section className="flex flex-col gap-2" aria-label={t("reviews.merged.title")} data-testid="reviews-merged">
            <button
                type="button"
                onClick={() => pref.set(!open)}
                onKeyDown={(e) => e.stopPropagation()}
                aria-expanded={open}
                className="flex w-fit cursor-pointer items-center gap-1.5 rounded-4 text-13 leading-5 font-semibold hover:text-primary"
                data-testid="reviews-merged-toggle"
            >
                <i
                    className={cn(
                        "fa fa-solid fa-chevron-right text-11 text-muted transition-transform duration-120 ease-mt",
                        open && "rotate-90"
                    )}
                    aria-hidden
                />
                {t("reviews.merged.title")}
                <span className="ml-0.5 text-12 font-normal text-muted">{merged.length}</span>
                <span className="text-11 font-normal text-muted">
                    · {t("reviews.merged.window", { days: MergedDays })}
                </span>
            </button>
            {open && answer.mergederror ? (
                <p className="text-11 text-muted" title={answer.mergederror}>
                    {t("reviews.merged.error")}
                </p>
            ) : null}
            {!open ? null : merged.length === 0 ? (
                answer.mergederror ? null : (
                    <p
                        className="rounded-4 border border-border px-3 py-3 text-13 leading-5 text-muted"
                        data-testid="reviews-merged-empty"
                    >
                        {t("reviews.merged.none", { target: answer.target, days: MergedDays })}
                    </p>
                )
            ) : (
                <div className="overflow-clip rounded-4 border border-border [overflow-clip-margin:1px]" role="list">
                    {merged.map((pr) => (
                        <MergedRow
                            key={pr.number}
                            pr={pr}
                            notes={noteCounts[pr.number] ?? 0}
                            onShowNotes={() => onShowNotes(`#${pr.number}`)}
                        />
                    ))}
                </div>
            )}
            {open ? (
                <button
                    type="button"
                    onClick={() => setHistoryOpen(true)}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="flex w-fit cursor-pointer items-center gap-1.5 rounded-4 text-12 text-accent hover:underline"
                    title={t("reviews.merged.allTitle", { target: answer.target })}
                    data-testid="reviews-merged-all"
                >
                    <i className="fa fa-solid fa-clock-rotate-left text-11" aria-hidden />
                    {t("reviews.merged.all")}
                </button>
            ) : null}
            {historyOpen ? (
                <Suspense fallback={null}>
                    <MergedHistoryWindow
                        dir={answer.dir}
                        repo={answer.repo}
                        target={answer.target}
                        onClose={() => setHistoryOpen(false)}
                        onShowNotes={onShowNotes}
                    />
                </Suspense>
            ) : null}
        </section>
    );
}

function MergedRow({ pr, notes, onShowNotes }: { pr: ReviewMergedPr; notes: number; onShowNotes: () => void }) {
    const t = useT();
    const ships = shipsLabel(pr);
    const openPr = () => fireAndForget(() => openWebLink(pr.url));
    const when = timeAgo(pr.mergedat);
    return (
        <div
            role="listitem"
            tabIndex={0}
            data-merged-pr={pr.number}
            aria-label={t("reviews.merged.openTitle", { number: pr.number })}
            title={t("reviews.merged.openTitle", { number: pr.number })}
            onClick={openPr}
            onKeyDown={(e) => {
                // The list's keys walk and open the review rows: a merged row's are its own.
                e.stopPropagation();
                if (e.key !== "Enter" || e.target !== e.currentTarget) {
                    return;
                }
                e.preventDefault();
                openPr();
            }}
            className="flex cursor-pointer flex-col gap-1 border-b border-border px-3 py-2 outline-none last:border-b-0 hover:bg-hover focus-visible:bg-hover"
            data-testid="reviews-merged-row"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate text-13 leading-5 font-medium">
                        {pr.ticket ? <span className="mr-1.5 text-accent">#{pr.ticket}</span> : null}
                        {pr.title}
                    </div>
                    <div className="truncate text-12 text-muted">
                        PR #{pr.number} · <code>{pr.branch}</code>
                        {pr.author ? ` · ${pr.author}` : ""} ·{" "}
                        <span
                            title={t("reviews.merged.mergedAtTitle", { when: formatWhen(pr.mergedat) })}
                            data-testid="reviews-merged-when"
                        >
                            {pr.mergedby
                                ? t("reviews.merged.mergedBy", { when, who: pr.mergedby })
                                : t("reviews.merged.mergedWhen", { when })}
                        </span>
                    </div>
                    <PrSignature agents={pr.agents} reviewed={pr.reviewed} testId="reviews-merged-signature" />
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    {ships ? (
                        <span
                            className={cn(Chip, ShipsClasses[ships.tone])}
                            title={ships.title}
                            data-testid="reviews-merged-ships"
                        >
                            <i
                                className={cn("fa fa-solid text-10", ships.tone === "success" ? "fa-tag" : "fa-box")}
                                aria-hidden
                            />
                            {ships.label}
                        </span>
                    ) : null}
                    {notes > 0 ? (
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                onShowNotes();
                            }}
                            className={cn(
                                Chip,
                                "cursor-pointer border-accent/40 bg-accent/10 text-accent hover:brightness-125"
                            )}
                            title={t("reviews.merged.notesTitle", { number: pr.number })}
                            data-testid="reviews-merged-notes"
                        >
                            <i className="fa fa-solid fa-book-open text-10" aria-hidden />
                            {notes === 1 ? t("reviews.merged.notesOne") : t("reviews.merged.notes", { count: notes })}
                        </button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
