// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Pilotage across a workspace's projects (FR-SHELL-087): filter chips (All projects, Desktop, Mobile…) above the list.
// All projects lists every project's open pull requests by whose turn it is, each with its project's tag; a row opens
// its project's chip on that pull request, where the full Pilotage of that project (cards, merge queue, upcoming,
// notes, merged) works as before.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState } from "../empty-state";
import { useT } from "../i18n/i18n";
import { useWordPhrase } from "../i18n/phrase";
import { useMissionSnapshot } from "../mission/mission-client";
import { ProjectChip } from "../sidebar/project-chips";
import { projectLabel, WorkspaceProjectEntry } from "../sidebar/workspace-projects";
import { workspaceShownName } from "../workspace-default-name";
import { openProjectSheet } from "../workspace-edit";
import { useCardContext } from "./reviews-agent-bar";
import { TurnTitleKeys } from "./reviews-card-model";
import { useReviews } from "./reviews-client";
import { rebaseAskKey, reviewsEmptyState, splitReviews } from "./reviews-model";
import { AllProjects, projectLanes, ProjectPrRow, ReviewsProjectFilter } from "./reviews-projects-model";
import { cardStates } from "./reviews-sections-model";
import { ReviewsModel } from "./reviews-store";

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
    const choose = (id: string) => ReviewsProjectFilter.getInstance().set(workspaceId, id);
    const chip = (id: string, label: string) => (
        <ProjectChip
            key={id}
            on={filter === id}
            label={label}
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
            {chip(AllProjects, t("reviews.projects.all"))}
            {projects.map((p) => chip(p.id, projectLabel(p)))}
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
    const { snapshot } = useMissionSnapshot(project.dir);
    const { answer, error, refresh } = useReviews(project.dir, snapshot);
    const readied = useAtomValue(ReviewsModel.getInstance().readiedAtom);
    const asks = useAtomValue(ReviewsModel.getInstance().rebaseAsksAtom);
    const ctx = useCardContext(project.dir);
    const listed = useMemo(() => {
        const split = splitReviews(answer, readied);
        return [...split.ready, ...split.drafts];
    }, [answer, readied]);
    const cards = useMemo(
        () => cardStates(listed, asks, (n) => rebaseAskKey(project.dir, n), ctx),
        [listed, asks, project.dir, ctx]
    );
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
        const rows = listed.map((pr) => ({ projectId: project.id, dir: project.dir, pr, card: cards[pr.number] }));
        onReport(project.id, { rows, loaded: true, note: empty?.title });
    }, [answer, error, listed, cards, project.id, project.dir]);
    return null;
}

const TurnTitle = TurnTitleKeys;

export function AllProjectsList({ workspace, projects }: { workspace: Workspace; projects: WorkspaceProjectEntry[] }) {
    const t = useT();
    const word = useWordPhrase();
    const [reports, setReports] = useState<Record<string, ProjectReport>>({});
    const [refreshKey, setRefreshKey] = useState(0);
    const onReport = useCallback((id: string, report: ProjectReport) => {
        setReports((prev) => ({ ...prev, [id]: report }));
    }, []);
    const linked = projects.filter((p) => p.dir !== "");
    const rowsByProject = useMemo(() => {
        const rtn: Record<string, ProjectPrRow[]> = {};
        for (const [id, report] of Object.entries(reports)) {
            rtn[id] = report.rows;
        }
        return rtn;
    }, [reports]);
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
                <ProjectProbe key={`${p.id}:${p.dir}`} project={p} refreshKey={refreshKey} onReport={onReport} />
            ))}
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
                    <i className={cn("fa fa-solid fa-rotate text-11", loading && "fa-spin mt-step-spin")} />
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
                                {row.card != null ? (
                                    <span className="ml-auto shrink-0 truncate pl-2 text-11 text-muted">
                                        {word(row.card.sentence)}
                                    </span>
                                ) : null}
                            </button>
                        ))}
                    </section>
                ))}
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
