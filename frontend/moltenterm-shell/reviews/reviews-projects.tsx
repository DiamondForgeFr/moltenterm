// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Pilotage across a workspace's projects (FR-SHELL-087): filter chips (All projects, Desktop, Mobile…) above the list.
// All projects lists every project's open pull requests by whose turn it is, each with its project's tag; a row opens
// its project's chip on that pull request, where the full Pilotage of that project (cards, merge queue, upcoming,
// notes, merged) works as before.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentChain } from "../agent-chain-store";
import { EmptyState } from "../empty-state";
import { useT } from "../i18n/i18n";
import { useWordPhrase } from "../i18n/phrase";
import { useMissionSnapshot } from "../mission/mission-client";
import { ProjectChip } from "../sidebar/project-chips";
import { projectLabel, projectRepoDir, WorkspaceProjectEntry } from "../sidebar/workspace-projects";
import { DominoLoader } from "../suite/suite";
import { workspaceShownName } from "../workspace-default-name";
import { openProjectSheet } from "../workspace-edit";
import { useCardContext } from "./reviews-agent-bar";
import { TurnTitleKeys } from "./reviews-card-model";
import { useReviews } from "./reviews-client";
import { rebaseAskKey, reviewsEmptyState, splitReviews } from "./reviews-model";
import { OthersWaitLine, OwnerChip, OwnersFilterHost } from "./reviews-owners";
import type { OwnersFilter } from "./reviews-owners-filter";
import { inScope, ownerFacts, ownersOf, prOwner, waitsForYou } from "./reviews-owners-model";
import { useViewScope } from "./reviews-owners-store";
import { AllProjects, projectLanes, ProjectPrRow, ReviewsProjectFilter } from "./reviews-projects-model";
import { cardStates } from "./reviews-sections-model";
import { ReviewsModel } from "./reviews-store";
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

type ProjectReport = { rows: ProjectPrRow[]; loaded: boolean; note?: string };

// One project's pull requests as Pilotage computes them (the same card states as its full list), told to the merged
// list; it draws nothing itself.
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
        onReport(project.id, { rows, loaded: true, note: empty?.title });
    }, [answer, error, listed, cards, project.id, dir, ctx.upcoming]);
    return null;
}

const TurnTitle = TurnTitleKeys;

export function AllProjectsList({
    workspace,
    projects,
    filter,
}: {
    workspace: Workspace;
    projects: WorkspaceProjectEntry[];
    filter: OwnersFilter;
}) {
    const t = useT();
    const word = useWordPhrase();
    const [reports, setReports] = useState<Record<string, ProjectReport>>({});
    const [refreshKey, setRefreshKey] = useState(0);
    const onReport = useCallback((id: string, report: ProjectReport) => {
        setReports((prev) => ({ ...prev, [id]: report }));
    }, []);
    const linked = projects.filter((p) => p.dir !== "");
    // The view's filter composes with the project chips (FR-REV-034): the agents of two projects in the view filter
    // this list on both, and each row keeps its project tag. What it hides is counted, and what waits is signalled.
    const view = useViewScope();
    const edges = useAtomValue(AgentChain.getInstance().edgesAtom);
    const [revealed, setRevealed] = useState(false);
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
    const notes = projects
        .map((p) => ({ project: p, note: p.dir === "" ? t("reviews.projects.noFolder") : reports[p.id]?.note }))
        .filter((n) => !!n.note);
    const labels = new Map(projects.map((p) => [p.id, projectLabel(p)]));
    const open = (row: ProjectPrRow) => {
        ReviewsProjectFilter.getInstance().set(workspace?.oid, row.projectId);
        globalStore.set(ReviewsModel.getInstance().focusAtom, { dir: row.dir, number: row.pr.number, at: Date.now() });
    };
    const name = workspaceShownName(workspace?.name, t);
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
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
                {lanes.length === 0 && !loading ? (
                    <EmptyState
                        icon="code-pull-request"
                        title={t("reviews.projects.none")}
                        hint={t("reviews.projects.noneHint", { name })}
                        testId="reviews-all-projects-empty"
                    />
                ) : null}
                {lanes.map((lane) => (
                    <section
                        key={lane.turn}
                        className="flex flex-col gap-1.5"
                        aria-label={t(TurnTitle[lane.turn])}
                        data-testid={`reviews-all-lane-${lane.turn}`}
                    >
                        <h4
                            className={cn(
                                "m-0 text-11 font-semibold tracking-[0.08em] uppercase",
                                lane.turn === "yours" ? "text-[var(--mt-state-waiting)]" : "text-muted"
                            )}
                        >
                            {t(TurnTitle[lane.turn])} · {lane.rows.length}
                        </h4>
                        {lane.rows.map((row) => (
                            <button
                                key={`${row.projectId}:${row.pr.number}`}
                                type="button"
                                className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-6 border-0 bg-white/[0.04] px-3 py-2 text-left text-13 text-primary transition-colors duration-120 ease-mt hover:bg-white/[0.08]"
                                title={t("reviews.projects.openTitle", {
                                    project: labels.get(row.projectId),
                                    number: row.pr.number,
                                })}
                                data-testid="reviews-all-row"
                                data-project={row.projectId}
                                data-pr={row.pr.number}
                                onClick={() => open(row)}
                            >
                                <span className="shrink-0 font-mono text-12 text-muted">#{row.pr.number}</span>
                                <span
                                    className="shrink-0 rounded-full bg-white/[0.08] px-1.5 py-px text-11 whitespace-nowrap text-secondary"
                                    data-testid="reviews-all-tag"
                                >
                                    {labels.get(row.projectId)}
                                </span>
                                <span className="min-w-0 truncate">{row.pr.title}</span>
                                <OwnerChip owner={ownerFacts(row.owner ?? "", edges)} />
                                {row.card != null ? (
                                    <span className="ml-auto shrink-0 truncate pl-2 text-11 text-muted">
                                        {word(row.card.sentence)}
                                    </span>
                                ) : null}
                            </button>
                        ))}
                    </section>
                ))}
                <OthersWaitLine
                    local={hiddenWaiting.length}
                    revealed={revealed}
                    onToggle={() => setRevealed((v) => !v)}
                />
                {notes.length > 0 ? (
                    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-11 text-muted">
                        {notes.map((n) => (
                            <li key={n.project.id}>
                                <span className="text-secondary">{projectLabel(n.project)}</span> · {n.note}
                            </li>
                        ))}
                    </ul>
                ) : null}
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
