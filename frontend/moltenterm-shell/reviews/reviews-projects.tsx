// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Pilotage across a workspace's projects (FR-SHELL-087): filter chips (All projects, Desktop, Mobile…) above the list.
// All projects lists every project's open pull requests by whose turn it is, each with its project's mark; a row opens
// its project's chip on that pull request, where the full Pilotage of that project (cards, merge queue, upcoming,
// notes, merged) works as before. Under the lanes, one Upcoming, one Notes and one Recently merged hold the cards of
// every project, each marked with its project (#2314); what is wrong with a project is one line at the top.

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentChain } from "../agent-chain-store";
import { EmptyState } from "../empty-state";
import { useT } from "../i18n/i18n";
import { useMissionSnapshot } from "../mission/mission-client";
import { useTrustDirs } from "../mission/trust-approval";
import { type ReviewNotes, useReviewNotes } from "../review/review-notes";
import { ProjectChip } from "../sidebar/project-chips";
import { projectLabel, projectRepoDir, WorkspaceProjectEntry } from "../sidebar/workspace-projects";
import { DominoLoader } from "../suite/suite";
import { openProjectSheet } from "../workspace-edit";
import { useCardContext } from "./reviews-agent-bar";
import { AllSource, markOf, projectProblems, sourceOf } from "./reviews-all-model";
import {
    AllLane,
    AllLaunchDialogs,
    AllMergedSection,
    AllNoneOpenLine,
    AllNotesAsk,
    AllNotesSection,
    AllProblemLines,
    AllUpcomingSection,
    Marks,
} from "./reviews-all-sections";
import { useReviews } from "./reviews-client";
import { LeftoverAsks, useLeftoverAsks } from "./reviews-leftover-asks";
import { rebaseAskKey, ReviewsAnswer, reviewsEmptyState, splitReviews } from "./reviews-model";
import { ReviewsFolds } from "./reviews-order-store";
import { OthersWaitLine, OwnersFilterHost } from "./reviews-owners";
import type { OwnersFilter } from "./reviews-owners-filter";
import { inScope, ownersOf, prOwner, waitsForYou } from "./reviews-owners-model";
import { useViewScope } from "./reviews-owners-store";
import {
    AllProjects,
    projectIdsOfFolders,
    projectLanes,
    ProjectPrRow,
    ReviewsProjectFilter,
} from "./reviews-projects-model";
import { cardStates } from "./reviews-sections-model";
import { ReviewsModel } from "./reviews-store";
import { UpcomingAnswers, useUpcomingWatch } from "./reviews-upcoming-client";
import { useProjectWaiting } from "./reviews-workspace";

export function ProjectChips({
    workspaceId,
    projects,
    filter,
}: {
    workspaceId: string;
    projects: WorkspaceProjectEntry[];
    filter: string;
}) {
    const t = useT();
    const choose = (id: string) => ReviewsProjectFilter.getInstance().choose(workspaceId, id);
    // What waits for the developer in each project, so a pull request waiting in another one is never invisible.
    const waiting = useProjectWaiting();
    const waitingOf = (p: WorkspaceProjectEntry) => (p.dir === "" ? 0 : (waiting[projectRepoDir(p)] ?? 0));
    const chip = (id: string, label: string, count: number) => (
        <ProjectChip
            key={id}
            on={filter === id}
            label={label}
            waiting={count}
            testId={`reviews-project-chip-${id}`}
            onClick={() => choose(id)}
        />
    );
    return (
        <div
            role="radiogroup"
            aria-label={t("reviews.projects.filter")}
            className="flex shrink-0 flex-wrap gap-1.5 border-b border-border px-3 py-2"
            data-testid="reviews-project-chips"
        >
            {chip(
                AllProjects,
                t("reviews.projects.all"),
                projects.reduce((sum, p) => sum + waitingOf(p), 0)
            )}
            {projects.map((p) => chip(p.id, projectLabel(p), waitingOf(p)))}
        </div>
    );
}

// What a project's probe follows and reports to All projects: its pull requests as lanes, and the answers the
// sections list (its review answer, its notes). The upcoming work and the leftover requests land in their own stores.
type ProjectReport = {
    rows: ProjectPrRow[];
    loaded: boolean;
    note?: string;
    answer?: ReviewsAnswer;
    notes?: ReviewNotes;
    notesError?: string;
    setNotes?: (notes: ReviewNotes) => void;
};

// One project's pull requests as Pilotage computes them (the same card states as its full list), told to the merged
// list; it draws nothing itself. It also follows what the sections list for the project: its upcoming work, its notes
// and the requests made to its leftovers' owners, so a hook per project runs here and not in the sections.
function ProjectProbe({
    project,
    refreshKey,
    onReport,
}: {
    project: WorkspaceProjectEntry;
    refreshKey: number;
    onReport: (id: string, report: ProjectReport) => void;
}) {
    // The collector's snapshot drives the asks, as in the full list: its GitHub read lands there first.
    const dir = projectRepoDir(project);
    const { snapshot } = useMissionSnapshot(dir);
    const { answer, error, refresh } = useReviews(dir, snapshot);
    const readied = useAtomValue(ReviewsModel.getInstance().readiedAtom);
    const asks = useAtomValue(ReviewsModel.getInstance().rebaseAsksAtom);
    const ctx = useCardContext(dir);
    // Only a project whose pull requests were read has work coming, notes or leftovers to follow.
    const read = answer?.state === "ok";
    useUpcomingWatch(dir, answer);
    useLeftoverAsks(read ? dir : "");
    const { notes, error: notesError, set: setNotes } = useReviewNotes(read ? (answer.repo ?? "") : "");
    const listed = useMemo(() => {
        const split = splitReviews(answer, readied);
        return [...split.ready, ...split.drafts];
    }, [answer, readied]);
    const cards = useMemo(() => cardStates(listed, asks, (n) => rebaseAskKey(dir, n), ctx), [listed, asks, dir, ctx]);
    useEffect(() => {
        if (refreshKey > 0) {
            refresh();
        }
    }, [refreshKey]);
    useEffect(() => {
        if (answer == null) {
            onReport(project.id, { rows: [], loaded: error != null, note: error ?? undefined });
            return;
        }
        const empty = reviewsEmptyState(answer);
        const rows = listed.map((pr) => ({
            projectId: project.id,
            dir,
            pr,
            card: cards[pr.number],
            owner: prOwner(pr, ctx.upcoming),
        }));
        onReport(project.id, { rows, loaded: true, note: empty?.title, answer, notes, notesError, setNotes });
    }, [answer, error, listed, cards, project.id, dir, ctx.upcoming, notes, notesError, setNotes]);
    return null;
}

export function AllProjectsList({
    workspace,
    projects,
    filter,
    blockId,
}: {
    workspace: Workspace;
    projects: WorkspaceProjectEntry[];
    filter: OwnersFilter;
    blockId: string;
}) {
    const t = useT();
    const [reports, setReports] = useState<Record<string, ProjectReport>>({});
    const [refreshKey, setRefreshKey] = useState(0);
    const onReport = useCallback((id: string, report: ProjectReport) => {
        setReports((prev) => ({ ...prev, [id]: report }));
    }, []);
    const linked = useMemo(() => projects.filter((p) => p.dir !== ""), [projects]);
    // The view's filter composes with the project chips (FR-REV-034): the agents of two projects in the view filter
    // this list on both, and each row keeps its project's mark. What it hides is counted, and what waits is signalled.
    const view = useViewScope();
    const edges = useAtomValue(AgentChain.getInstance().edgesAtom);
    const upcomings = useAtomValue(UpcomingAnswers.getInstance().answersAtom);
    const leftoverAsks = useAtomValue(LeftoverAsks.getInstance().asksAtom);
    const [revealed, setRevealed] = useState(false);
    const [notesAsk, setNotesAsk] = useState<AllNotesAsk>(null);
    // "Show notes" on a merged pull request filters the Notes right under it: open for now, as a project's own view does.
    useEffect(() => {
        if (notesAsk != null) {
            ReviewsFolds.getInstance().openForNow("", "notes");
        }
    }, [notesAsk]);
    const allRows = useMemo(() => Object.values(reports).flatMap((r) => r.rows), [reports]);
    const hiddenRows = useMemo(
        () => allRows.filter((row) => !inScope(row.owner ?? "", view.names)),
        [allRows, view.names]
    );
    const hiddenWaiting = hiddenRows.filter((row) => waitsForYou(row.card));
    const rowsByProject = useMemo(() => {
        const rtn: Record<string, ProjectPrRow[]> = {};
        for (const [id, report] of Object.entries(reports)) {
            rtn[id] = report.rows.filter(
                (row) => inScope(row.owner ?? "", view.names) || (revealed && waitsForYou(row.card))
            );
        }
        return rtn;
    }, [reports, view.names, revealed]);
    const owners = useMemo(
        () =>
            ownersOf(
                allRows.map((row) => row.owner ?? ""),
                edges
            ),
        [allRows, edges]
    );
    const lanes = projectLanes(projects, rowsByProject);
    const loading = linked.some((p) => !reports[p.id]?.loaded);
    const trustDirs = useTrustDirs();
    const problems = useMemo(() => {
        const trustOf: Record<string, string> = {};
        for (const dir of trustDirs) {
            const id = projectIdsOfFolders(projects, [dir])[0];
            if (id != null && trustOf[id] == null) {
                trustOf[id] = dir;
            }
        }
        return projectProblems(
            projects,
            (id) => reports[id]?.note ?? "",
            (id) => trustOf[id] ?? ""
        );
    }, [projects, reports, trustDirs]);
    const place = !!workspace?.color;
    const workspaceId = workspace?.oid;
    const marks: Marks = useMemo(
        () => ({
            place,
            onChoose: (id: string) => ReviewsProjectFilter.getInstance().choose(workspaceId, id),
        }),
        [place, workspaceId]
    );
    // The projects whose pull requests were read: the sections list their cards, and only theirs.
    const sources: AllSource[] = useMemo(
        () =>
            linked
                .filter((p) => reports[p.id]?.answer?.state === "ok")
                .map((p) => {
                    const report = reports[p.id];
                    return sourceOf(p, {
                        answer: report.answer,
                        upcoming: upcomings[projectRepoDir(p)],
                        notes: report.notes,
                        notesError: report.notesError,
                        setNotes: report.setNotes,
                        asks: leftoverAsks[projectRepoDir(p)],
                    });
                }),
        [linked, reports, upcomings, leftoverAsks]
    );
    const facts = (id: string) => {
        const project = projects.find((p) => p.id === id);
        return markOf({ project, answer: reports[id]?.answer }, place);
    };
    const open = (row: ProjectPrRow) => {
        ReviewsProjectFilter.getInstance().set(workspace?.oid, row.projectId);
        globalStore.set(ReviewsModel.getInstance().focusAtom, { dir: row.dir, number: row.pr.number, at: Date.now() });
    };
    return (
        <div className="flex min-h-0 flex-1 flex-col" data-testid="reviews-all-projects">
            {linked.map((p) => (
                <ProjectProbe
                    key={`${p.id}:${projectRepoDir(p)}`}
                    project={p}
                    refreshKey={refreshKey}
                    onReport={onReport}
                />
            ))}
            <OwnersFilterHost filter={filter} view={view} owners={owners} hidden={hiddenRows.length} />
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <span className="text-12 text-secondary">
                    {t("reviews.projects.count", { count: projects.length })}
                </span>
                <button
                    type="button"
                    aria-label={t("mc.frame.refresh")}
                    title={t("mc.frame.refreshTitle")}
                    onClick={() => setRefreshKey((k) => k + 1)}
                    className="ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded-6 text-secondary hover:bg-hover hover:text-primary"
                >
                    {loading ? (
                        <DominoLoader className="mt-dominos-icon" />
                    ) : (
                        <i className="fa fa-solid fa-rotate text-11" />
                    )}
                </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
                <AllProblemLines problems={problems} marks={marks} />
                {lanes.map((lane) => (
                    <AllLane key={lane.turn} lane={lane} facts={facts} marks={marks} edges={edges} onOpen={open} />
                ))}
                {lanes.length === 0 && !loading ? <AllNoneOpenLine hidden={hiddenRows.length > 0} /> : null}
                <OthersWaitLine
                    local={hiddenWaiting.length}
                    revealed={revealed}
                    onToggle={() => setRevealed((v) => !v)}
                />
                {sources.length > 0 ? (
                    <>
                        <AllUpcomingSection sources={sources} names={view.names} marks={marks} />
                        <AllNotesSection sources={sources} blockId={blockId} ask={notesAsk} marks={marks} />
                        <AllMergedSection
                            sources={sources}
                            marks={marks}
                            onShowNotes={(text, source) =>
                                setNotesAsk({ filter: text, projectId: source.project.id, at: Date.now() })
                            }
                        />
                    </>
                ) : null}
                <AllLaunchDialogs sources={sources} />
            </div>
        </div>
    );
}

// A project of the workspace without a folder has no pull requests to show until it gets one.
export function ProjectWithoutFolder({ project }: { project: WorkspaceProjectEntry }) {
    const t = useT();
    return (
        <EmptyState
            icon="folder-open"
            title={t("reviews.projects.noFolderTitle", { project: projectLabel(project) })}
            hint={t("reviews.projects.noFolder")}
            primary={{
                label: t("sidebar.project.editMenu", { project: projectLabel(project) }),
                onClick: () => openProjectSheet(project.id),
            }}
        />
    );
}
