// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project view (FR-MC-020, DS-MC-012): Mission Control's single overview of the linked project, shown by the
// Project tab (FR-SHELL-015, DS-SHELL-015). Top to bottom: the header band with the actions, the line map, then one
// row of four cards that wraps on narrow panes. The core reads the project's data once and lays out the slots; the
// cards themselves come from the registry (project-cards.ts), built-in ones first.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { ErrorBoundary } from "@/app/element/errorboundary";
import { fireAndForget } from "@/util/util";
import { atom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Notice, Problem } from "../mission/cicd-panels";
import { MoltentermCicdView } from "../mission/cicd-view";
import { ciRun, missionTrust, useCiState, useMissionRuns, useReleaseSession } from "../mission/mission-client";
import { ActiveProject, MissionFrame, MissionHeader, PipelineBanner } from "../mission/mission-frame";
import { MissionSnapshot, UntrustedInfo } from "../mission/mission-model";
import { TrustPrompt, useStartRun } from "../mission/runs-view";
import { openMoltentermView } from "../open-view";
import { pathBaseName } from "../workspace-project";
import { BuiltinProjectCards } from "./project-builtin-cards";
import { layoutProjectCards, ProjectCard } from "./project-cards";
import { ProjectCardProps, registerProjectCard, useProjectCards } from "./project-context";
import { MoltentermProjectView } from "./project-model";

// The card that follows what runs: a start from the header scrolls it into view.
const NowCardId = "moltenterm:now";

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
                <ProjectContent key={project.dir} project={project} snapshot={snapshot} refresh={refresh} />
            )}
        </MissionFrame>
    );
}

function CardFailed({ error, title }: { error?: Error; title: string }) {
    return <Problem text={`${title} could not be shown: ${error?.message ?? "unknown error"}`} />;
}

function CardBody({ card, props }: { card: ProjectCard<ProjectCardProps>; props: ProjectCardProps }) {
    const Component = card.component;
    return (
        <ErrorBoundary fallback={<CardFailed title={card.title} />}>
            <Component {...props} />
        </ErrorBoundary>
    );
}

function CardSlot({ card, props }: { card: ProjectCard<ProjectCardProps>; props: ProjectCardProps }) {
    if (card.bare) {
        return (
            <div className="min-w-0" data-card={card.id}>
                <CardBody card={card} props={props} />
            </div>
        );
    }
    return (
        <section
            className="flex min-w-0 flex-col gap-3 overflow-visible rounded-md border border-border bg-panel px-4 py-3.5"
            data-card={card.id}
        >
            <h2 className="text-[11px] font-semibold tracking-[0.14em] text-muted uppercase">{card.title}</h2>
            <div className="flex min-h-0 flex-1 flex-col">
                <CardBody card={card} props={props} />
            </div>
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
    const rootRef = useRef<HTMLDivElement>(null);
    const report = snapshot?.pipeline;
    const pipeline = report?.valid ? report.pipeline : null;
    // The CI's verdicts are read for the branches' heads: when the trunk moves, the verdict on its new head is asked
    // again, so the Now card follows the trunk as the status bar does (#234).
    const git = snapshot?.git;
    const trunkHead = (git?.branches ?? []).find((b) => b.name === git?.trunk)?.sha ?? "";
    const trunkHeadSeen = useRef(trunkHead);
    useEffect(() => {
        if (trunkHead === trunkHeadSeen.current) {
            return;
        }
        trunkHeadSeen.current = trunkHead;
        reloadCi();
    }, [trunkHead, reloadCi]);

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
    const showRuns = useCallback(
        () => rootRef.current?.querySelector(`[data-card="${NowCardId}"]`)?.scrollIntoView({ block: "nearest" }),
        []
    );

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
                    onClick={() => fireAndForget(() => openMoltentermView(MoltentermCicdView))}
                    className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs text-secondary hover:bg-hover hover:text-primary"
                    title="Open the CI/CD panel beside this view: history, detail and logs"
                >
                    <i className="fa fa-solid fa-list-check text-[10px]" />
                    CI/CD
                </button>
            </MissionHeader>
            <div ref={rootRef} className="flex min-h-0 flex-1 flex-col overflow-auto" data-testid="project-view">
                {regions.header.length > 0 ? (
                    <section
                        aria-label="Project header"
                        className="flex flex-col border-b border-border bg-panel"
                        data-slot="header"
                    >
                        {regions.header.map((card) => (
                            <CardSlot key={card.id} card={card} props={props} />
                        ))}
                    </section>
                ) : null}
                <div className="flex flex-col gap-3 p-3">
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
                    {regions.map.length > 0 ? (
                        <div className="flex flex-col gap-3" data-slot="map">
                            {regions.map.map((card) => (
                                <CardSlot key={card.id} card={card} props={props} />
                            ))}
                        </div>
                    ) : null}
                    {regions.cards.length > 0 ? (
                        <div
                            className="grid gap-3 @min-[42rem]:grid-cols-2 @min-[68.75rem]:grid-cols-4"
                            data-slot="cards"
                            data-testid="project-cards"
                        >
                            {regions.cards.map((card) => (
                                <CardSlot key={card.id} card={card} props={props} />
                            ))}
                        </div>
                    ) : null}
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
