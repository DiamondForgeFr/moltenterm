// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The merged history (#960, FR-REV-030), opened from Recently merged's "All merged pull requests": the shape of the
// version history (DS-REL-004, versions left and content right) for the project's own PRs. Left: All, the next
// version, each release with its candidates (months for a project without release tags). Right: the PRs of the entry,
// grouped by day, 50 at a time. Search and filters apply to the whole history. Loaded lazily from reviews-merged.tsx.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { DialogFrame } from "../dialog-frame";
import { useLocale, useT, useTCount } from "../i18n/i18n";
import { dateLocale, formatWhen } from "../mission/time-format";
import { openWebLink } from "../open-web-link";
import { useReviewNotes } from "../review/review-notes";
import {
    AllKey,
    byDay,
    filterChoices,
    filterHistory,
    hasFilters,
    historyEntries,
    HistoryEntry,
    HistoryFilters,
    HistoryPageSize,
    HistoryPollMs,
    inEntry,
    MergedHistoryPr,
    MergedHistoryStore,
    NoFilters,
} from "./merged-history-model";
import { PrSignature } from "./pr-signature";
import { notesByPr, shipsLabel } from "./reviews-merged-model";

const Chip = "inline-flex items-center gap-1 rounded-4 border px-1.5 py-0.5 text-11 leading-4 whitespace-nowrap";
const ShipsClasses = {
    success: "border-success/40 bg-success/10 text-success",
    neutral: "border-border bg-hover text-muted",
};
const FieldClass =
    "h-7 rounded-4 border border-border bg-surface-1 px-2 text-12 text-primary outline-none focus:border-accent";

function formatLongDay(day: string): string {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T12:00:00`) : null;
    if (d == null || Number.isNaN(d.getTime())) {
        return day;
    }
    return d.toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "long", year: "numeric" });
}

function formatMonth(month: string): string {
    const d = /^\d{4}-\d{2}$/.test(month) ? new Date(`${month}-15T12:00:00`) : null;
    if (d == null || Number.isNaN(d.getTime())) {
        return month;
    }
    return d.toLocaleDateString(dateLocale(), { month: "long", year: "numeric" });
}

export function MergedHistoryWindow({
    dir,
    repo,
    target,
    onClose,
    onShowNotes,
}: {
    dir: string;
    repo: string;
    target: string;
    onClose: () => void;
    onShowNotes: (filter: string) => void;
}) {
    const t = useT();
    const tCount = useTCount();
    // The day and month headings follow the interface language.
    useLocale();
    const store = MergedHistoryStore.getInstance();
    const answers = useAtomValue(store.answersAtom);
    const answer = answers[dir];
    const { notes } = useReviewNotes(repo);
    const noteCounts = useMemo(() => notesByPr(notes?.notes), [notes]);
    const [askError, setAskError] = useState<string>(null);
    const [refreshAt, setRefreshAt] = useState(0);
    const [filters, setFilters] = useState<HistoryFilters>(NoFilters);
    const [selected, setSelected] = useState(AllKey);
    const [shown, setShown] = useState(HistoryPageSize);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let alive = true;
        let timer: ReturnType<typeof setTimeout> = null;
        const ask = async (force: boolean) => {
            try {
                const next = await store.load(dir, force);
                if (!alive) {
                    return;
                }
                setAskError(null);
                if (next?.loading) {
                    timer = setTimeout(() => fireAndForget(() => ask(false)), HistoryPollMs);
                }
            } catch (e) {
                if (alive) {
                    setAskError(String(e?.message ?? e));
                }
            }
        };
        fireAndForget(() => ask(refreshAt > 0));
        return () => {
            alive = false;
            clearTimeout(timer);
        };
    }, [dir, refreshAt]);

    const all = answer?.prs ?? [];
    const tags = answer?.tags ?? [];
    const hasTags = tags.length > 0;
    const filtered = useMemo(() => filterHistory(all, filters), [all, filters]);
    const entries = useMemo(
        () => historyEntries(all, filtered, tags, answer?.tagprefix ?? ""),
        [all, filtered, tags, answer?.tagprefix]
    );
    const selectable = entries.filter((e) => e.kind !== "upcoming");
    const current = selectable.find((e) => e.key === selected) ?? selectable[0];
    const prs = useMemo(() => inEntry(filtered, current?.key, hasTags), [filtered, current?.key, hasTags]);
    const choices = useMemo(() => filterChoices(all), [all]);
    useEffect(() => setShown(HistoryPageSize), [current?.key, filters]);
    const days = useMemo(() => byDay(prs.slice(0, shown)), [prs, shown]);

    const setFilter = (patch: Partial<HistoryFilters>) => setFilters((f) => ({ ...f, ...patch }));
    const entryLabel = (entry: HistoryEntry): string => {
        switch (entry.kind) {
            case "all":
                return t("reviews.history.all");
            case "next":
                return t("reviews.history.next");
            case "tag":
                return entry.tag;
            case "month":
                return formatMonth(entry.month);
            case "unknown":
                return t("reviews.history.unknown");
        }
        return "";
    };
    const move = (e: React.KeyboardEvent) => {
        const keys = selectable.map((s) => s.key);
        const index = keys.indexOf(current?.key);
        let next = index;
        if (e.key === "ArrowDown") {
            next = Math.min(keys.length - 1, index + 1);
        } else if (e.key === "ArrowUp") {
            next = Math.max(0, index - 1);
        } else {
            return;
        }
        e.preventDefault();
        setSelected(keys[next]);
        requestAnimationFrame(() =>
            listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(keys[next])}"]`)?.focus()
        );
    };

    const loading = answer == null || answer.loading;
    const status = askError
        ? t("reviews.history.error")
        : answer?.error
          ? t("reviews.history.error")
          : loading
            ? all.length > 0 && answer?.total > 0
                ? t("reviews.history.loading", { count: all.length, total: answer.total })
                : t("reviews.history.loadingFirst")
            : answer?.cut
              ? t("reviews.history.cut", { count: all.length })
              : null;
    return (
        <DialogFrame
            role="merged-history"
            onEscape={onClose}
            onBackdrop={onClose}
            title={t("reviews.history.title")}
            subtitle={t("reviews.history.subtitle", { repo, target })}
            widthClass="w-[1000px]"
            buttons={
                <>
                    <button
                        type="button"
                        onClick={() => setRefreshAt(Date.now())}
                        disabled={answer?.loading}
                        className="mr-auto cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary disabled:opacity-50"
                        data-testid="merged-history-refresh"
                    >
                        <i className={cn("fa fa-solid fa-rotate mr-1.5", answer?.loading && "fa-spin")} aria-hidden />
                        {t("reviews.history.refresh")}
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                    >
                        {t("common.close")}
                    </button>
                </>
            }
        >
            <div className="-mx-4 -my-3 flex h-[min(72vh,640px)] min-h-0 flex-col" data-testid="merged-history">
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
                    <input
                        type="search"
                        value={filters.text}
                        onChange={(e) => setFilter({ text: e.target.value })}
                        placeholder={t("reviews.history.search")}
                        aria-label={t("reviews.history.search")}
                        className={cn(FieldClass, "min-w-[220px] flex-1")}
                        data-testid="merged-history-search"
                        autoFocus
                    />
                    <select
                        value={filters.milestone}
                        onChange={(e) => setFilter({ milestone: e.target.value })}
                        aria-label={t("reviews.history.milestone")}
                        className={cn(FieldClass, "max-w-[160px] cursor-pointer")}
                        data-testid="merged-history-milestone"
                    >
                        <option value="">{t("reviews.history.anyMilestone")}</option>
                        {choices.milestones.map((m) => (
                            <option key={m} value={m}>
                                {m}
                            </option>
                        ))}
                    </select>
                    <select
                        value={filters.person}
                        onChange={(e) => setFilter({ person: e.target.value })}
                        aria-label={t("reviews.history.person")}
                        className={cn(FieldClass, "max-w-[180px] cursor-pointer")}
                        data-testid="merged-history-person"
                    >
                        <option value="">{t("reviews.history.anyPerson")}</option>
                        {choices.people.map((p) => (
                            <option key={p} value={p}>
                                {p}
                            </option>
                        ))}
                    </select>
                    <label className="flex items-center gap-1 text-11 text-muted">
                        {t("reviews.history.from")}
                        <input
                            type="date"
                            value={filters.from}
                            onChange={(e) => setFilter({ from: e.target.value })}
                            className={cn(FieldClass, "cursor-pointer")}
                            data-testid="merged-history-from"
                        />
                    </label>
                    <label className="flex items-center gap-1 text-11 text-muted">
                        {t("reviews.history.to")}
                        <input
                            type="date"
                            value={filters.to}
                            onChange={(e) => setFilter({ to: e.target.value })}
                            className={cn(FieldClass, "cursor-pointer")}
                            data-testid="merged-history-to"
                        />
                    </label>
                    {hasFilters(filters) ? (
                        <button
                            type="button"
                            onClick={() => setFilters(NoFilters)}
                            className="cursor-pointer text-12 text-accent hover:underline"
                            data-testid="merged-history-clear"
                        >
                            {t("reviews.history.clear")}
                        </button>
                    ) : null}
                </div>
                {status ? (
                    <div
                        className="border-b border-border px-4 py-1.5 text-11 text-muted"
                        title={askError ?? answer?.error ?? undefined}
                        data-testid="merged-history-status"
                    >
                        {loading && !askError && !answer?.error ? (
                            <i className="fa fa-solid fa-spinner fa-spin mr-1.5" aria-hidden />
                        ) : null}
                        {status}
                    </div>
                ) : null}
                <div className="flex min-h-0 flex-1">
                    <div
                        ref={listRef}
                        role="navigation"
                        aria-label={hasTags ? t("reviews.history.versions") : t("reviews.history.months")}
                        onKeyDown={move}
                        className="flex w-[210px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-2"
                        data-testid="merged-history-entries"
                    >
                        {entries.map((entry) => {
                            if (entry.kind === "upcoming") {
                                return (
                                    <div
                                        key={entry.key}
                                        className="mt-1 flex items-center gap-1.5 px-2 py-1 text-12 text-muted"
                                    >
                                        <span className="font-mono">{entry.base}</span>
                                        <span className="text-11">{t("reviews.history.upcoming")}</span>
                                    </div>
                                );
                            }
                            const active = entry.key === current?.key;
                            return (
                                <button
                                    key={entry.key}
                                    type="button"
                                    data-key={entry.key}
                                    tabIndex={active ? 0 : -1}
                                    aria-current={active ? "true" : undefined}
                                    onClick={() => setSelected(entry.key)}
                                    title={
                                        entry.kind === "next"
                                            ? t("reviews.history.nextTitle")
                                            : entry.kind === "unknown"
                                              ? t("reviews.history.unknownTitle")
                                              : undefined
                                    }
                                    className={cn(
                                        "flex w-full cursor-pointer items-center justify-between gap-2 rounded-4 px-2 py-1 text-left text-12",
                                        entry.kind === "tag" && entry.nested && "pl-5",
                                        entry.kind === "all" && "mb-1",
                                        active
                                            ? "bg-hover font-medium text-primary"
                                            : "text-secondary hover:bg-hover/60 hover:text-primary"
                                    )}
                                    data-testid="merged-history-entry"
                                >
                                    <span className={cn("truncate", entry.kind === "tag" && "font-mono tabular-nums")}>
                                        {entryLabel(entry)}
                                    </span>
                                    <span className="shrink-0 text-11 text-muted tabular-nums">{entry.count}</span>
                                </button>
                            );
                        })}
                    </div>
                    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-3" data-testid="merged-history-pane">
                        {current ? (
                            <div className="mb-2 flex items-baseline gap-2">
                                <h2 className="text-14 font-semibold text-primary">{entryLabel(current)}</h2>
                                <span className="text-12 text-muted">{tCount("reviews.history.prs", prs.length)}</span>
                            </div>
                        ) : null}
                        {prs.length === 0 && !loading ? (
                            <p className="text-12 text-muted" data-testid="merged-history-empty">
                                {all.length === 0
                                    ? t("reviews.history.none", { target })
                                    : t("reviews.history.noMatch")}
                            </p>
                        ) : null}
                        {days.map((group) => (
                            <section key={group.day} className="mb-3">
                                <h3 className="sticky top-[-12px] z-[1] bg-surface-3 py-1 text-11 font-semibold tracking-wide text-muted uppercase">
                                    {formatLongDay(group.day)}
                                </h3>
                                <div className="overflow-clip rounded-4 border border-border" role="list">
                                    {group.prs.map((pr) => (
                                        <HistoryRow
                                            key={pr.number}
                                            pr={pr}
                                            notes={noteCounts[pr.number] ?? 0}
                                            onShowNotes={() => {
                                                onShowNotes(`#${pr.number}`);
                                                onClose();
                                            }}
                                        />
                                    ))}
                                </div>
                            </section>
                        ))}
                        {prs.length > shown ? (
                            <button
                                type="button"
                                onClick={() => setShown((n) => n + HistoryPageSize)}
                                className="w-full cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                                data-testid="merged-history-more"
                            >
                                {t("reviews.history.showMore", {
                                    count: Math.min(HistoryPageSize, prs.length - shown),
                                    left: prs.length - shown,
                                })}
                            </button>
                        ) : null}
                    </div>
                </div>
            </div>
        </DialogFrame>
    );
}

function HistoryRow({ pr, notes, onShowNotes }: { pr: MergedHistoryPr; notes: number; onShowNotes: () => void }) {
    const t = useT();
    const ships = shipsLabel(pr);
    const openPr = () => fireAndForget(() => openWebLink(pr.url));
    const when = formatWhen(pr.mergedat);
    const ticketUrl =
        pr.ticketurl || (pr.ticket && pr.url ? pr.url.replace(/\/pull\/\d+$/, `/issues/${pr.ticket}`) : "");
    return (
        <div
            role="listitem"
            tabIndex={0}
            data-history-pr={pr.number}
            title={t("reviews.merged.openTitle", { number: pr.number })}
            onClick={openPr}
            onKeyDown={(e) => {
                if (e.key !== "Enter" || e.target !== e.currentTarget) {
                    return;
                }
                e.preventDefault();
                openPr();
            }}
            className="flex cursor-pointer flex-col gap-1 border-b border-border px-3 py-2 outline-none last:border-b-0 hover:bg-hover focus-visible:bg-hover"
            data-testid="merged-history-row"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate text-13 leading-5 font-medium">
                        {pr.ticket ? <span className="mr-1.5 text-accent">#{pr.ticket}</span> : null}
                        {pr.title}
                    </div>
                    {pr.tickettitle || pr.tickettype || pr.milestone ? (
                        <div className="flex min-w-0 items-center gap-1.5 text-12 text-secondary">
                            {pr.tickettitle ? (
                                <span className="truncate" data-testid="merged-history-ticket">
                                    {t("reviews.history.ticketLine", { number: pr.ticket, title: pr.tickettitle })}
                                </span>
                            ) : null}
                            {pr.tickettype ? (
                                <span className={cn(Chip, "border-border text-muted")}>{pr.tickettype}</span>
                            ) : null}
                            {pr.milestone ? (
                                <span
                                    className={cn(Chip, "border-border text-muted")}
                                    title={t("reviews.history.milestoneTitle", { name: pr.milestone })}
                                >
                                    <i className="fa fa-solid fa-flag text-10" aria-hidden />
                                    {pr.milestone}
                                </span>
                            ) : null}
                        </div>
                    ) : null}
                    <div className="truncate text-12 text-muted">
                        PR #{pr.number} · <code>{pr.branch}</code>
                        {pr.author ? ` · ${pr.author}` : ""} ·{" "}
                        {pr.mergedby
                            ? t("reviews.history.mergedBy", { when, who: pr.mergedby })
                            : t("reviews.history.mergedOn", { when })}
                        {pr.mergemethod === "merge"
                            ? ` · ${t("reviews.history.methodMerge")}`
                            : pr.mergemethod === "linear"
                              ? ` · ${t("reviews.history.methodLinear")}`
                              : ""}
                        {pr.reviewers?.length
                            ? ` · ${t("reviews.history.reviewedBy", { who: pr.reviewers.join(", ") })}`
                            : ""}
                    </div>
                    <PrSignature agents={pr.agents} reviewed={pr.reviewed} testId="merged-history-signature" />
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    {ships ? (
                        <span
                            className={cn(Chip, ShipsClasses[ships.tone])}
                            title={ships.title}
                            data-testid="merged-history-ships"
                        >
                            <i
                                className={cn("fa fa-solid text-10", ships.tone === "success" ? "fa-tag" : "fa-box")}
                                aria-hidden
                            />
                            {ships.label}
                        </span>
                    ) : null}
                    {ticketUrl ? (
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                fireAndForget(() => openWebLink(ticketUrl));
                            }}
                            className={cn(Chip, "cursor-pointer border-border text-secondary hover:text-primary")}
                            title={t("reviews.history.ticketTitle", { number: pr.ticket })}
                            data-testid="merged-history-ticket-link"
                        >
                            <i className="fa fa-solid fa-ticket text-10" aria-hidden />#{pr.ticket}
                        </button>
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
                            data-testid="merged-history-notes"
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
