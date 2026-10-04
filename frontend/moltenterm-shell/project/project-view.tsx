// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project tab's view (FR-SHELL-015, DS-SHELL-015): the Mission Control home of a linked workspace, summary before
// detail. The core reads the project's data once and lays out the cards (status band, main column, side column);
// the cards themselves come from the registry (project-cards.ts), built-in ones first.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { ErrorBoundary } from "@/app/element/errorboundary";
import { cn, fireAndForget } from "@/util/util";
import { atom } from "jotai";
import { useCallback, useMemo, useRef, useState } from "react";
import { Notice, Problem } from "../mission/cicd-panels";
import { MoltentermCicdView } from "../mission/cicd-view";
import { ciRun, missionTrust, useCiState, useMissionRuns, useReleaseSession } from "../mission/mission-client";
import { ActiveProject, MissionFrame, MissionHeader, PipelineBanner } from "../mission/mission-frame";
import { MissionSnapshot, UntrustedInfo } from "../mission/mission-model";
import { TrustPrompt, useStartRun } from "../mission/runs-view";
import { MoltentermTimelineView } from "../mission/timeline-view";
import { openMoltentermView } from "../open-view";
import { pathBaseName } from "../workspace-project";
import { BuiltinProjectCards } from "./project-builtin-cards";
import { layoutProjectCards, ProjectCard } from "./project-cards";
import { ProjectCardProps, registerProjectCard, useProjectCards } from "./project-context";

// must match ProjectView in pkg/molten/mission/projecttab.go
export const MoltentermProjectView = "molten-project";

for (const card of BuiltinProjectCards) {
    registerProjectCard(card);
}

export class ProjectViewModel implements ViewModel {
    viewType = MoltentermProjectView;
    blockId: string;
    nodeModel: BlockNodeModel;
    viewIcon = atom("gauge");
    viewName = atom("Project");
    noPadding = atom(true);

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
    }

    get viewComponent(): ViewComponent {
        return ProjectView;
    }
}

function ProjectView() {
    return (
        <MissionFrame title="The Project tab">
            {({ project, snapshot, refresh }) => (
                <ProjectContent project={project} snapshot={snapshot} refresh={refresh} />
            )}
        </MissionFrame>
    );
}

function CardFailed({ error, title }: { error?: Error; title: string }) {
    return <Problem text={`${title} could not be shown: ${error?.message ?? "unknown error"}`} />;
}

function CardSlot({ card, props }: { card: ProjectCard<ProjectCardProps>; props: ProjectCardProps }) {
    const Component = card.component;
    const body = (
        <ErrorBoundary fallback={<CardFailed title={card.title} />}>
            <Component {...props} />
        </ErrorBoundary>
    );
    if (card.bare) {
        return body;
    }
    return (
        <section className="overflow-visible rounded border border-border" data-card={card.id}>
            <h2 className="border-b border-border px-3 py-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
                {card.title}
            </h2>
            {body}
        </section>
    );
}

function ProjectContent({
    project,
    snapshot,
    refresh,
}: {
    project: ActiveProject;
    snapshot: MissionSnapshot;
    refresh: () => void;
}) {
    const dir = project.dir;
    const projectName = project.facts?.name ?? pathBaseName(dir);
    const runs = useMissionRuns(dir);
    const { state: ci, reload: reloadCi } = useCiState(dir);
    const { session: release, reload: reloadRelease } = useReleaseSession(dir);
    const { startAsync, prompt, error, clearError } = useStartRun(dir, projectName);
    const [ciError, setCiError] = useState<string>(null);
    const [untrusted, setUntrusted] = useState<{ branch: string; info: UntrustedInfo }>(null);
    const sideRef = useRef<HTMLDivElement>(null);
    const report = snapshot?.pipeline;
    const pipeline = report?.valid ? report.pipeline : null;

    const runCi = useCallback(
        (branch: string) =>
            fireAndForget(async () => {
                setCiError(null);
                try {
                    const result = await ciRun(dir, branch, false);
                    if (result?.untrusted) {
                        setUntrusted({ branch, info: result.untrusted });
                    }
                } catch (e) {
                    setCiError(String(e?.message ?? e));
                }
            }),
        [dir]
    );
    const trustAndRunCi = () =>
        fireAndForget(async () => {
            const pending = untrusted;
            setUntrusted(null);
            try {
                await missionTrust(dir, pending.info.hash);
                runCi(pending.branch);
            } catch (e) {
                setCiError(String(e?.message ?? e));
            }
        });
    const showRuns = useCallback(() => sideRef.current?.scrollIntoView({ block: "nearest" }), []);

    const cards = useProjectCards();
    const regions = useMemo(() => layoutProjectCards(cards), [cards]);
    const props: ProjectCardProps = {
        project,
        projectName,
        snapshot,
        refresh,
        pipeline,
        runs,
        ci,
        reloadCi,
        release,
        reloadRelease,
        startBuild: (id) => startAsync("build", id),
        runCi,
        showRuns,
    };
    const problem = error ?? ciError;
    return (
        <>
            <MissionHeader project={project} snapshot={snapshot} onRefresh={refresh}>
                <button
                    type="button"
                    onClick={() => fireAndForget(() => openMoltentermView(MoltentermTimelineView))}
                    className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs text-secondary hover:bg-hover hover:text-primary"
                    title="Open the Timeline panel beside this view"
                >
                    <i className="fa fa-solid fa-code-branch text-[10px]" />
                    Timeline
                </button>
                <button
                    type="button"
                    onClick={() => fireAndForget(() => openMoltentermView(MoltentermCicdView))}
                    className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs text-secondary hover:bg-hover hover:text-primary"
                    title="Open the CI/CD panel beside this view"
                >
                    <i className="fa fa-solid fa-list-check text-[10px]" />
                    CI/CD
                </button>
            </MissionHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3" data-testid="project-view">
                <PipelineBanner dir={dir} report={report} />
                {problem ? (
                    <div className="flex items-center gap-2">
                        <div className="flex-1">
                            <Problem text={problem} />
                        </div>
                        <button
                            type="button"
                            onClick={() => {
                                clearError();
                                setCiError(null);
                            }}
                            className="cursor-pointer text-xs text-muted hover:text-primary"
                        >
                            Dismiss
                        </button>
                    </div>
                ) : null}
                {snapshot?.git?.fetcherror ? (
                    <Notice
                        text={`Showing the local state: fetching from the remote failed (${snapshot.git.fetcherror}).`}
                    />
                ) : null}
                {regions.band.length > 0 ? (
                    <section
                        aria-label="Status"
                        className="grid divide-y divide-border rounded border border-border @3xl:auto-cols-fr @3xl:grid-flow-col @3xl:divide-x @3xl:divide-y-0"
                        data-testid="project-band"
                    >
                        {regions.band.map((card) => (
                            <div key={card.id} className="min-w-0 px-3 py-2" data-card={card.id}>
                                {card.bare ? null : (
                                    <h2 className="mb-1 text-[11px] font-medium tracking-wide text-muted uppercase">
                                        {card.title}
                                    </h2>
                                )}
                                <ErrorBoundary fallback={<CardFailed title={card.title} />}>
                                    <card.component {...props} />
                                </ErrorBoundary>
                            </div>
                        ))}
                    </section>
                ) : null}
                <div className="grid gap-3 @3xl:grid-cols-[minmax(0,1fr)_340px]">
                    <div className="flex min-w-0 flex-col gap-3">
                        {regions.main.map((card) => (
                            <CardSlot key={card.id} card={card} props={props} />
                        ))}
                    </div>
                    <div ref={sideRef} className={cn("flex min-w-0 flex-col gap-3")}>
                        {regions.side.map((card) => (
                            <CardSlot key={card.id} card={card} props={props} />
                        ))}
                    </div>
                </div>
            </div>
            {prompt}
            {untrusted != null ? (
                <TrustPrompt
                    projectName={projectName}
                    dir={dir}
                    info={untrusted.info}
                    onTrust={trustAndRunCi}
                    onCancel={() => setUntrusted(null)}
                />
            ) : null}
        </>
    );
}
