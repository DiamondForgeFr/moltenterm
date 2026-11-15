// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What Integration's All projects shows under the open pull requests (#2314, FR-SHELL-087): one Upcoming (with its
// leftovers), one Notes and one Recently merged for the whole workspace, each listing the cards of every project, each
// card marked with its project. The cards are the ones a project's own view draws, acting on the project of the card;
// the sections' headings and empty texts are drawn by the same components too, so an empty section says so once, not
// once per project.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ChainEdge } from "../agent-chain-store";
import { AgentStates } from "../agent-state-store";
import { useT } from "../i18n/i18n";
import { useWordPhrase } from "../i18n/phrase";
import { serverText } from "../i18n/server-text";
import { reviewProjectCommands } from "../mission/trust-approval";
import { openProjectSheet } from "../workspace-edit";
import {
    allLeftovers,
    AllMergedGroup,
    allMergedGroups,
    allNotes,
    allUpcoming,
    markOf,
    mergedCount,
    noteCount,
    notesRead,
    ProjectMarkFacts,
    ProjectProblem,
    type AllSource,
} from "./reviews-all-model";
import { TurnTitleKeys } from "./reviews-card-model";
import { LaunchDialogs } from "./reviews-launch";
import { LaunchModel } from "./reviews-launch-client";
import { LeftoversView, useLeftoverContinues } from "./reviews-leftovers";
import { LeftoversModel } from "./reviews-leftovers-client";
import { leftoverKey } from "./reviews-leftovers-model";
import { MergedGroupView, MergedHistoryWindow } from "./reviews-merged";
import { MergedDays, MergedOpenPref, notesByPr } from "./reviews-merged-model";
import { NotesView } from "./reviews-notes-view";
import { ReviewsFolds, sectionOpen } from "./reviews-order-store";
import { OwnerChip } from "./reviews-owners";
import { ownerFacts, type ScopeNames } from "./reviews-owners-model";
import { ProjectMark } from "./reviews-project-mark";
import type { ProjectLane, ProjectPrRow } from "./reviews-projects-model";
import { SectionHeading } from "./reviews-section-heading";
import { UpcomingCard, UpcomingView } from "./reviews-upcoming";

// Every section reads the project's marks the same way: the facts of the project, and the choice a click makes.
export type Marks = { place: boolean; onChoose: (projectId: string) => void };

function markFor(source: AllSource, marks: Marks) {
    return <ProjectMark facts={markOf(source, marks.place)} onChoose={marks.onChoose} />;
}

// The Notes a "Show notes" on a merged pull request asks for: that pull request's number in that project (a number
// alone would also match the notes of another project's pull request with the same number).
export type AllNotesAsk = { filter: string; projectId: string; at: number };

export function AllUpcomingSection({
    sources,
    names,
    marks,
}: {
    sources: AllSource[];
    names: ScopeNames;
    marks: Marks;
}) {
    const states = useAtomValue(AgentStates.getInstance().dataAtom);
    const folds = useAtomValue(ReviewsFolds.getInstance().foldsAtom);
    const all = useMemo(() => allUpcoming(sources, states, names), [sources, states, names]);
    const cards: UpcomingCard[] = useMemo(
        () =>
            all.cards.map((card) => ({
                entry: card.entry,
                dir: card.source.dir,
                repoUrl: card.source.answer?.url,
                base: card.source.upcoming?.target,
                mark: markFor(card.source, marks),
            })),
        [all, marks]
    );
    const open = sectionOpen(folds, "", "upcoming", true);
    const failed = sources.find((s) => !!s.upcoming?.ticketserror);
    const errored = sources.find((s) => !!s.upcoming?.error);
    return (
        <>
            <UpcomingView
                cards={cards}
                count={all.started ? all.count : ""}
                ready={all.started && (cards.length > 0 || all.ready)}
                waiting={all.waiting}
                open={open}
                onToggle={() => ReviewsFolds.getInstance().set("upcoming", !open)}
                emptyTitle={errored ? serverText(errored.upcoming.errortext, errored.upcoming.error) : undefined}
                ticketsError={failed != null}
                ticketsErrorTitle={failed?.upcoming.ticketserror}
            />
            <AllLeftoversSection sources={sources} marks={marks} />
        </>
    );
}

function AllLeftoversSection({ sources, marks }: { sources: AllSource[]; marks: Marks }) {
    const states = useAtomValue(AgentStates.getInstance().dataAtom);
    const cleanup = useAtomValue(LeftoversModel.getInstance().statesAtom);
    const folds = useAtomValue(ReviewsFolds.getInstance().foldsAtom);
    const leftovers = useMemo(
        () => allLeftovers(sources, states, (dir, leftover) => cleanup[leftoverKey(dir, leftover.pr)]?.cleanedAt ?? 0),
        [sources, states, cleanup]
    );
    const targets = useMemo(() => leftovers.map((l) => l.target), [leftovers]);
    useLeftoverContinues(targets);
    const items = useMemo(
        () =>
            leftovers.map((l) => ({
                target: l.target,
                repoUrl: l.source.answer?.url,
                mark: markFor(l.source, marks),
                project: markOf(l.source, marks.place).label,
            })),
        [leftovers, marks]
    );
    if (items.length === 0) {
        return null;
    }
    return (
        <LeftoversView
            items={items}
            open={sectionOpen(folds, "", "leftovers", true)}
            onToggle={(open) => ReviewsFolds.getInstance().set("leftovers", open)}
        />
    );
}

export function AllNotesSection({
    sources,
    blockId,
    ask,
    marks,
}: {
    sources: AllSource[];
    blockId: string;
    ask: AllNotesAsk;
    marks: Marks;
}) {
    const folds = useAtomValue(ReviewsFolds.getInstance().foldsAtom);
    const [filter, setFilter] = useState("");
    const [only, setOnly] = useState<string>(null);
    const sectionRef = useRef<HTMLElement>(null);
    useEffect(() => {
        if (ask == null) {
            return;
        }
        setFilter(ask.filter);
        setOnly(ask.projectId);
        sectionRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    }, [ask]);
    const items = useMemo(
        () =>
            allNotes(sources, filter, only).map((n) => ({
                note: n.note,
                dir: n.source.dir,
                repo: n.source.answer?.repo,
                onNotes: n.source.setNotes,
                mark: markFor(n.source, marks),
            })),
        [sources, filter, only, marks]
    );
    const open = sectionOpen(folds, "", "notes", true);
    return (
        <NotesView
            items={items}
            total={noteCount(sources)}
            loaded={notesRead(sources)}
            error={sources.find((s) => !!s.notesError)?.notesError ?? null}
            blockId={blockId}
            filter={filter}
            onFilter={(value) => {
                setFilter(value);
                setOnly(null);
            }}
            open={open}
            onToggle={() => ReviewsFolds.getInstance().set("notes", !open)}
            sectionRef={sectionRef}
        />
    );
}

type History = { source: AllSource; initial: string };

export function AllMergedSection({
    sources,
    marks,
    onShowNotes,
}: {
    sources: AllSource[];
    marks: Marks;
    onShowNotes: (filter: string, source: AllSource) => void;
}) {
    const t = useT();
    const pref = MergedOpenPref.getInstance();
    const open = useAtomValue(pref.openAtom) ?? true;
    const groups = useMemo(() => allMergedGroups(sources), [sources]);
    const count = mergedCount(sources);
    const failed = sources.filter((s) => !!s.answer?.mergederror);
    const [history, setHistory] = useState<History>(null);
    const [shown, setShown] = useState<{ group: string; number: number }>(null);
    return (
        <section className="flex flex-col gap-2" aria-label={t("reviews.merged.title")} data-testid="reviews-merged">
            <SectionHeading
                title={t("reviews.merged.title")}
                count={count}
                hint={t("reviews.merged.window", { days: MergedDays })}
                open={open}
                onToggle={() => pref.set(!open)}
                testId="reviews-merged-toggle"
            />
            {open && failed.length > 0 ? (
                <p
                    className="text-11 text-muted"
                    title={failed.map((s) => `${markOf(s, false).label}: ${s.answer.mergederror}`).join("\n")}
                >
                    {t("reviews.merged.error")}
                </p>
            ) : null}
            {!open ? null : groups.length === 0 ? (
                failed.length > 0 ? null : (
                    <p
                        className="rounded-4 border border-border px-3 py-3 text-13 leading-5 text-muted"
                        data-testid="reviews-merged-empty"
                    >
                        {t("reviews.projects.mergedNone", { days: MergedDays })}
                    </p>
                )
            ) : (
                <div className="overflow-clip rounded-4 border border-border [overflow-clip-margin:1px]" role="list">
                    {groups.map((entry) => (
                        <MergedGroupOf
                            key={entry.key}
                            entry={entry}
                            marks={marks}
                            open={shown?.group === entry.key ? shown.number : null}
                            onToggle={(number) =>
                                setShown(
                                    shown?.group === entry.key && shown.number === number
                                        ? null
                                        : { group: entry.key, number }
                                )
                            }
                            onShowNotes={(filter) => onShowNotes(filter, entry.source)}
                            onHistory={() => setHistory({ source: entry.source, initial: entry.group.key })}
                        />
                    ))}
                </div>
            )}
            {history != null ? (
                <Suspense fallback={null}>
                    <MergedHistoryWindow
                        dir={history.source.dir}
                        repo={history.source.answer.repo}
                        target={history.source.answer.target}
                        initial={history.initial}
                        onClose={() => setHistory(null)}
                        onShowNotes={(filter) => onShowNotes(filter, history.source)}
                    />
                </Suspense>
            ) : null}
        </section>
    );
}

function MergedGroupOf({
    entry,
    marks,
    open,
    onToggle,
    onShowNotes,
    onHistory,
}: {
    entry: AllMergedGroup;
    marks: Marks;
    open: number;
    onToggle: (number: number) => void;
    onShowNotes: (filter: string) => void;
    onHistory: () => void;
}) {
    const noteCounts = useMemo(() => notesByPr(entry.source.notes?.notes), [entry.source.notes]);
    return (
        <MergedGroupView
            group={entry.group}
            dir={entry.source.dir}
            trunk={entry.source.answer?.target}
            noteCounts={noteCounts}
            open={open}
            onToggle={onToggle}
            onShowNotes={onShowNotes}
            onHistory={onHistory}
            mark={markFor(entry.source, marks)}
        />
    );
}

// What is wrong with a project, one line each at the top of the list: a project without a folder, a project whose pull
// requests could not be read. Never a block: the project's own view says more, one click away.
export function AllProblemLines({ problems, marks }: { problems: ProjectProblem[]; marks: Marks }) {
    const t = useT();
    if (problems.length === 0) {
        return null;
    }
    return (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="reviews-all-problems">
            {problems.map((problem) => {
                const facts: ProjectMarkFacts = markOf({ project: problem.project, answer: null }, marks.place);
                return (
                    <li
                        key={`${problem.project.id}:${problem.kind}`}
                        className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 rounded-4 border border-border px-3 py-1.5 text-12 leading-5 text-secondary"
                        data-testid="reviews-all-problem"
                        data-project={problem.project.id}
                        data-kind={problem.kind}
                    >
                        {problem.kind === "nofolder" ? (
                            <>
                                <span>{t("reviews.projects.noFolderTitle", { project: facts.label })}</span>
                                <span aria-hidden>·</span>
                                <button
                                    type="button"
                                    onClick={() => openProjectSheet(problem.project.id)}
                                    className="cursor-pointer text-accent hover:underline"
                                    data-testid="reviews-all-give-folder"
                                >
                                    {t("reviews.projects.giveFolder")}
                                </button>
                            </>
                        ) : problem.kind === "trust" ? (
                            <>
                                <span>{t("reviews.projects.trustTitle", { project: facts.label })}</span>
                                <span aria-hidden>·</span>
                                <button
                                    type="button"
                                    onClick={() => fireAndForget(() => reviewProjectCommands(problem.dir))}
                                    className="cursor-pointer text-accent hover:underline"
                                    data-testid="reviews-all-trust"
                                >
                                    {t("reviewsAgents.trustReview")}
                                </button>
                            </>
                        ) : (
                            <>
                                <span className="font-medium text-primary">{facts.label}</span>
                                <span aria-hidden>·</span>
                                <span className="min-w-0 text-muted">{problem.note}</span>
                            </>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

// The confirmation of a launch asked from a card (FR-REV-031), once for the whole list: it names what the launch
// replaces and loses, and is the developer's to approve. Its trunk is the one of the project the launch was asked in.
export function AllLaunchDialogs({ sources }: { sources: AllSource[] }) {
    const ask = useAtomValue(LaunchModel.getInstance().askAtom);
    const trunk = sources.find((s) => s.dir === ask?.dir)?.answer?.target ?? "";
    return <LaunchDialogs trunk={trunk} />;
}

// One lane of open pull requests (Needs you, Ready to merge…): the pull requests of every project in that turn, each
// marked with its project. A row opens its project's chip on that pull request.
export function AllLane({
    lane,
    facts,
    marks,
    edges,
    onOpen,
}: {
    lane: ProjectLane;
    facts: (projectId: string) => ProjectMarkFacts;
    marks: Marks;
    edges: readonly ChainEdge[];
    onOpen: (row: ProjectPrRow) => void;
}) {
    const t = useT();
    const word = useWordPhrase();
    return (
        <section
            className="flex flex-col gap-1.5"
            aria-label={t(TurnTitleKeys[lane.turn])}
            data-testid={`reviews-all-lane-${lane.turn}`}
        >
            <h4
                className={cn(
                    "m-0 text-11 font-semibold tracking-[0.08em] uppercase",
                    lane.turn === "yours" ? "text-[var(--mt-state-waiting)]" : "text-muted"
                )}
            >
                {t(TurnTitleKeys[lane.turn])} · {lane.rows.length}
            </h4>
            <div className="flex flex-col gap-1.5" role="list">
                {lane.rows.map((row) => (
                    <div
                        key={`${row.projectId}:${row.pr.number}`}
                        role="listitem"
                        tabIndex={0}
                        className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-6 bg-white/[0.04] px-3 py-2 text-left text-13 text-primary outline-none transition-colors duration-120 ease-mt hover:bg-white/[0.08] focus-visible:bg-white/[0.08]"
                        title={t("reviews.projects.openTitle", {
                            project: facts(row.projectId).label,
                            number: row.pr.number,
                        })}
                        data-testid="reviews-all-row"
                        data-project={row.projectId}
                        data-pr={row.pr.number}
                        onClick={() => onOpen(row)}
                        onKeyDown={(e) => {
                            if (e.key !== "Enter" || e.target !== e.currentTarget) {
                                return;
                            }
                            e.preventDefault();
                            onOpen(row);
                        }}
                    >
                        <span className="shrink-0 font-mono text-12 text-muted">#{row.pr.number}</span>
                        <ProjectMark facts={facts(row.projectId)} onChoose={marks.onChoose} />
                        <span className="min-w-0 truncate">{row.pr.title}</span>
                        <OwnerChip owner={ownerFacts(row.owner ?? "", edges)} />
                        {row.card != null ? (
                            <span className="ml-auto shrink-0 truncate pl-2 text-11 text-muted">
                                {word(row.card.sentence)}
                            </span>
                        ) : null}
                    </div>
                ))}
            </div>
        </section>
    );
}

// No pull request is listed in any project: none is open, or the view's filter hides the ones that are. One line for
// the whole workspace, not one per project.
export function AllNoneOpenLine({ hidden }: { hidden: boolean }) {
    const t = useT();
    return (
        <p
            className="rounded-4 border border-border px-3 py-3 text-13 leading-5 text-muted"
            data-testid="reviews-none-open"
        >
            {hidden ? t("reviews.owners.noneShown") : t("reviews.projects.noneOpen")}
        </p>
    );
}
