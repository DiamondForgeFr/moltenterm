// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's Recently merged section (#843), last in the panel: a merged PR leaves the review list, and this
// says it merged, when and where it ships. The PRs are grouped by the version that ships them (#1061, FR-REV-027 AC6
// to AC8): the next version first, then each tag, each group linking to the merged history on that version (#960,
// FR-REV-030). One compact row per PR: ticket, title, agent and model, a mark when notes are kept on it, age; a click
// or Enter opens its details under it. Its heading line opens the whole merged history (#1070).

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { lazy, Suspense, useMemo, useState } from "react";
import { modelDisplayName } from "../companion/companion-proportion";
import { TFunction, useT, useTCount } from "../i18n/i18n";
import { formatWhen } from "../mission/time-format";
import { openWebLink } from "../open-web-link";
import { useReviewNotes } from "../review/review-notes";
import { LaunchBackButton } from "./reviews-launch";
import { mergedByQueueText, mergeKey, ReviewsMerges } from "./reviews-merges";
import { MergedDays, MergedOpenPref, notesByPr, ReviewMergedPr } from "./reviews-merged-model";
import type { ReviewsAnswer } from "./reviews-model";
import { SectionHeading } from "./reviews-section-heading";
import { MergedGroup, MergedGroupRows, mergedGroups, mergedTitle, mergedWho } from "./reviews-sections-model";

// The merged history (#960) loads on its first opening: most views never open it.
const MergedHistoryWindow = lazy(() =>
    import("./merged-history-window").then((m) => ({ default: m.MergedHistoryWindow }))
);

const LinkButton = "shrink-0 cursor-pointer text-11 leading-4 font-normal text-accent hover:underline";

// "12 min", "3 h", "2 d": a merged row's age.
export function mergedAge(t: TFunction, iso: string, now: number): string {
    const ms = Math.max(0, now - new Date(iso).getTime());
    if (Number.isNaN(ms)) {
        return "";
    }
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) {
        return t("reviews.merged.age.minutes", { count: Math.max(1, minutes) });
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return t("reviews.merged.age.hours", { count: hours });
    }
    return t("reviews.merged.age.days", { count: Math.floor(hours / 24) });
}

export function MergedSection({
    answer,
    onShowNotes,
    defaultOpen = true,
}: {
    answer: ReviewsAnswer;
    onShowNotes: (filter: string) => void;
    // Folded by default when the panel's content is longer than the panel (#1061), until the developer chooses.
    defaultOpen?: boolean;
}) {
    const t = useT();
    const pref = MergedOpenPref.getInstance();
    const chosen = useAtomValue(pref.openAtom);
    const open = chosen ?? defaultOpen;
    const { notes } = useReviewNotes(answer.repo);
    const noteCounts = useMemo(() => notesByPr(notes?.notes), [notes]);
    const merged = answer.merged ?? [];
    const groups = useMemo(() => mergedGroups(merged), [merged]);
    // The history dialog, and the version it opens on ("" for All).
    const [history, setHistory] = useState<string>(null);
    const [shown, setShown] = useState<number>(null);
    return (
        <section className="flex flex-col gap-2" aria-label={t("reviews.merged.title")} data-testid="reviews-merged">
            <SectionHeading
                title={t("reviews.merged.title")}
                count={merged.length}
                hint={t("reviews.merged.window", { days: MergedDays })}
                open={open}
                onToggle={() => pref.set(!open)}
                testId="reviews-merged-toggle"
            >
                {/* On the heading line, collapsed or not (#1070): a link under the list went unseen. */}
                <button
                    type="button"
                    onClick={() => setHistory("")}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-4 border border-border px-2 py-0.5 text-12 leading-5 font-normal text-secondary hover:bg-hover hover:text-primary"
                    title={t("reviews.merged.allTitle", { target: answer.target })}
                    data-testid="reviews-merged-all"
                >
                    <i className="fa fa-solid fa-clock-rotate-left text-11 text-accent" aria-hidden />
                    {t("reviews.merged.all")}
                </button>
            </SectionHeading>
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
                    {groups.map((group) => (
                        <MergedGroupView
                            key={group.key}
                            group={group}
                            dir={answer.dir}
                            trunk={answer.target}
                            noteCounts={noteCounts}
                            open={shown}
                            onToggle={(n) => setShown(shown === n ? null : n)}
                            onShowNotes={onShowNotes}
                            onHistory={() => setHistory(group.key)}
                        />
                    ))}
                </div>
            )}
            {history != null ? (
                <Suspense fallback={null}>
                    <MergedHistoryWindow
                        dir={answer.dir}
                        repo={answer.repo}
                        target={answer.target}
                        initial={history}
                        onClose={() => setHistory(null)}
                        onShowNotes={onShowNotes}
                    />
                </Suspense>
            ) : null}
        </section>
    );
}

function groupTitle(t: TFunction, group: MergedGroup): string {
    switch (group.kind) {
        case "next":
            return t("reviews.merged.group.next");
        case "tag":
            return t("reviews.merged.group.tag", { tag: group.tag });
    }
    return t("reviews.merged.group.unknown");
}

function MergedGroupView({
    group,
    dir,
    trunk,
    noteCounts,
    open,
    onToggle,
    onShowNotes,
    onHistory,
}: {
    group: MergedGroup;
    dir: string;
    trunk: string;
    noteCounts: Record<number, number>;
    open: number;
    onToggle: (number: number) => void;
    onShowNotes: (filter: string) => void;
    onHistory: () => void;
}) {
    const t = useT();
    const tCount = useTCount();
    const rows = group.prs.slice(0, MergedGroupRows);
    const more = group.prs.length - rows.length;
    const link =
        group.kind === "next"
            ? t("reviews.merged.group.prepare")
            : group.kind === "tag"
              ? t("reviews.merged.group.notes")
              : "";
    const stopKeys = (e: React.KeyboardEvent) => e.stopPropagation();
    return (
        <div role="group" aria-label={groupTitle(t, group)} data-testid="reviews-merged-group" data-group={group.key}>
            <div className="flex items-center gap-2 border-b border-border bg-black/10 px-3 py-1 text-11 leading-4">
                <b className="min-w-0 truncate font-semibold text-secondary">{groupTitle(t, group)}</b>
                <span className="shrink-0 text-muted tabular-nums">{group.prs.length}</span>
                <span className="flex-1" />
                {link ? (
                    <button
                        type="button"
                        onClick={onHistory}
                        onKeyDown={stopKeys}
                        className={LinkButton}
                        title={t("reviews.merged.group.historyTitle")}
                        data-testid="reviews-merged-group-link"
                    >
                        {link}
                    </button>
                ) : null}
            </div>
            {rows.map((pr) => (
                <MergedRow
                    key={pr.number}
                    dir={dir}
                    trunk={trunk}
                    pr={pr}
                    notes={noteCounts[pr.number] ?? 0}
                    open={open === pr.number}
                    onToggle={() => onToggle(pr.number)}
                    onShowNotes={() => onShowNotes(`#${pr.number}`)}
                />
            ))}
            {more > 0 ? (
                <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-11 leading-4 text-muted">
                    <span>{tCount("reviews.merged.more", more)}</span>
                    <span className="flex-1" />
                    <button
                        type="button"
                        onClick={onHistory}
                        onKeyDown={stopKeys}
                        className={LinkButton}
                        data-testid="reviews-merged-show-all"
                    >
                        {t("reviews.merged.showAll")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function MergedRow({
    dir,
    trunk,
    pr,
    notes,
    open,
    onToggle,
    onShowNotes,
}: {
    dir: string;
    trunk: string;
    pr: ReviewMergedPr;
    notes: number;
    open: boolean;
    onToggle: () => void;
    onShowNotes: () => void;
}) {
    const t = useT();
    const local = useAtomValue(ReviewsMerges.getInstance().mergesAtom)[mergeKey(dir, pr.number)];
    const who = mergedWho(pr, modelDisplayName);
    const title = mergedTitle(pr);
    const whoText = [
        mergedByQueueText(local?.byqueue),
        who.agent
            ? [who.agent, who.model].filter(Boolean).join(" · ")
            : who.you && !local?.byqueue
              ? t("reviews.merged.you")
              : "",
        who.author ? t("reviews.merged.by", { name: who.author }) : "",
        who.reviewer ? t("reviews.signature.reviewedBy", { name: who.reviewer }) : "",
    ]
        .filter(Boolean)
        .join(" · ");
    const sig = pr.agents?.[0];
    const num = pr.ticket ? pr.ticket : pr.number;
    return (
        <>
            <div
                role="listitem"
                tabIndex={0}
                data-merged-pr={pr.number}
                aria-expanded={open}
                aria-label={t("reviews.merged.rowAria", { number: num, title })}
                onClick={onToggle}
                onKeyDown={(e) => {
                    // The list's keys walk and open the review rows: a merged row's are its own.
                    e.stopPropagation();
                    if (e.key !== "Enter" || e.target !== e.currentTarget) {
                        return;
                    }
                    e.preventDefault();
                    onToggle();
                }}
                className={cn(
                    "flex min-w-0 cursor-pointer items-center gap-2 border-b border-border px-3 py-1.5 text-12 leading-5 outline-none last:border-b-0 hover:bg-hover focus-visible:bg-hover",
                    open && "bg-hover/60"
                )}
                data-testid="reviews-merged-row"
            >
                <span className="shrink-0 text-accent tabular-nums">#{num}</span>
                <span className="min-w-0 flex-1 truncate" title={title}>
                    {title}
                </span>
                {whoText ? (
                    <span className="max-w-[40%] shrink-0 truncate text-11 text-muted" data-testid="reviews-merged-who">
                        {whoText}
                    </span>
                ) : null}
                <span className="flex w-4 shrink-0 justify-center">
                    {notes > 0 ? (
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                onShowNotes();
                            }}
                            className="cursor-pointer text-11 text-accent hover:brightness-125"
                            title={
                                notes === 1 ? t("reviews.merged.notesOne") : t("reviews.merged.notes", { count: notes })
                            }
                            aria-label={t("reviews.merged.notesTitle", { number: pr.number })}
                            data-testid="reviews-merged-notes"
                        >
                            ✎
                        </button>
                    ) : null}
                </span>
                <span
                    className="w-10 shrink-0 text-right text-11 text-muted tabular-nums"
                    title={t("reviews.merged.mergedAtTitle", { when: formatWhen(pr.mergedat) })}
                    data-testid="reviews-merged-when"
                >
                    {mergedAge(t, pr.mergedat, Date.now())}
                </span>
            </div>
            {open ? (
                <div
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-black/10 px-3 py-1.5 pl-8 text-11 leading-4 text-muted"
                    data-testid="reviews-merged-detail"
                >
                    <button
                        type="button"
                        onClick={() => fireAndForget(() => openWebLink(pr.url))}
                        className={LinkButton}
                        title={t("reviews.merged.openTitle", { number: pr.number })}
                    >
                        {t("reviews.merged.prLink", { number: pr.number })}
                    </button>
                    <code className="min-w-0 truncate">{pr.branch}</code>
                    {sig?.agent || sig?.effort ? (
                        <span>{[sig.agent, sig.effort].filter(Boolean).join(" · ")}</span>
                    ) : null}
                    <span>{t("reviews.merged.mergedAt", { when: formatWhen(pr.mergedat) })}</span>
                    {notes > 0 ? (
                        <button type="button" onClick={onShowNotes} className={LinkButton}>
                            {notes === 1 ? t("reviews.merged.notesOne") : t("reviews.merged.notes", { count: notes })}
                        </button>
                    ) : null}
                    <LaunchBackButton dir={dir} number={pr.number} trunk={trunk} />
                </div>
            ) : null}
        </>
    );
}
