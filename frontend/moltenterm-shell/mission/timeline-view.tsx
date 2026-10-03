// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Mission Control's Timeline panel (FR-MC-002), modelled on Notulia's Dev › Timeline: the branches as a tree beside
// where the releases stand, with the Build local and Release menus in its header.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { fireAndForget } from "@/util/util";
import { atom } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { pathBaseName } from "../workspace-project";
import { BranchTree } from "./branch-tree";
import { BuildLocalMenu } from "./build-local-menu";
import { BuildManifest } from "./builds-model";
import { Notice, Problem } from "./cicd-panels";
import { missionBuilds, useMissionRuns, useReleaseSession } from "./mission-client";
import { ActiveProject, MissionFrame, MissionHeader, PipelineBanner } from "./mission-frame";
import {
    latestRun,
    MissionGit,
    MissionGithub,
    MissionSnapshot,
    prsByBranch,
    RunRecord,
    toTreeData,
} from "./mission-model";
import { ReleaseMenu } from "./release-menu";
import { ReleaseRunSection } from "./release-run-panel";
import { ReleaseStatePanel } from "./release-state-panel";
import { BuildRunCard, useStartRun } from "./runs-view";
import { releaseState } from "./versions";

export const MoltentermTimelineView = "molten-timeline";

const DayChoices = [7, 21, 60, 180];

export class TimelineViewModel implements ViewModel {
    viewType = MoltentermTimelineView;
    blockId: string;
    nodeModel: BlockNodeModel;
    viewIcon = atom("code-branch");
    viewName = atom("Timeline");
    noPadding = atom(true);

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
    }

    get viewComponent(): ViewComponent {
        return TimelineView;
    }
}

// The manifest a finished build left, read again once the run ends.
function useDeliveredManifest(dir: string, run: RunRecord): BuildManifest {
    const [manifest, setManifest] = useState<BuildManifest>(null);
    useEffect(() => {
        setManifest(null);
        if (run == null || run.state !== "success") {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            const facts = await missionBuilds(dir, false);
            const last = facts?.builds?.find((b) => b.id === run.stepid)?.last ?? null;
            if (!cancelled) {
                setManifest(last);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [dir, run?.id, run?.state]);
    return manifest;
}

function TimelineView() {
    const [days, setDays] = useState(21);
    return (
        <MissionFrame title="Timeline">
            {({ project, snapshot, refresh }) => (
                <TimelineContent
                    project={project}
                    snapshot={snapshot}
                    refresh={refresh}
                    days={days}
                    setDays={setDays}
                />
            )}
        </MissionFrame>
    );
}

function TimelineContent({
    project,
    snapshot,
    refresh,
    days,
    setDays,
}: {
    project: ActiveProject;
    snapshot: MissionSnapshot;
    refresh: () => void;
    days: number;
    setDays: (days: number) => void;
}) {
    const projectName = project.facts?.name ?? pathBaseName(project.dir);
    const runs = useMissionRuns(project.dir);
    const { start, startAsync, prompt, error, clearError } = useStartRun(project.dir, projectName);
    const git = snapshot?.git;
    const github = snapshot?.github;
    const report = snapshot?.pipeline;
    const pipeline = report?.valid ? report.pipeline : null;
    const lastBuild = latestRun(runs, "build");
    const building = lastBuild?.state === "running";
    const buildDef = (pipeline?.builds ?? []).find((b) => b.id === lastBuild?.stepid);
    const delivered = useDeliveredManifest(project.dir, lastBuild);
    const showRun = () => document.querySelector(`[data-testid="build-run"]`)?.scrollIntoView({ block: "nearest" });
    const { session: releaseSession, reload: reloadRelease } = useReleaseSession(project.dir);
    const showRelease = () =>
        (
            document.querySelector(`[data-testid="release-run"]`) ??
            document.querySelector(`[data-testid="release-state"]`)
        )?.scrollIntoView({ block: "nearest" });
    return (
        <>
            <TimelineBody
                days={days}
                header={
                    <MissionHeader project={project} snapshot={snapshot} onRefresh={refresh}>
                        <select
                            value={days}
                            onChange={(e) => setDays(Number(e.target.value))}
                            className="cursor-pointer rounded border border-border bg-transparent px-1.5 py-1 text-xs text-secondary"
                            aria-label="Period"
                        >
                            {DayChoices.map((d) => (
                                <option key={d} value={d} className="bg-modalbg">
                                    {d} days
                                </option>
                            ))}
                        </select>
                        {pipeline ? (
                            <BuildLocalMenu
                                dir={project.dir}
                                projectName={projectName}
                                running={building ? lastBuild : null}
                                onBuild={(id) => startAsync("build", id)}
                                onShowRun={showRun}
                            />
                        ) : null}
                        {pipeline ? (
                            <ReleaseMenu
                                dir={project.dir}
                                projectName={projectName}
                                session={releaseSession}
                                rcSteps={pipeline.release?.rc ?? []}
                                publicSteps={pipeline.release?.public ?? []}
                                onStarted={() => {
                                    reloadRelease();
                                    showRelease();
                                }}
                                onShowRelease={showRelease}
                            />
                        ) : null}
                    </MissionHeader>
                }
                banner={
                    <>
                        <PipelineBanner dir={project.dir} report={snapshot?.pipeline} />
                        {error ? (
                            <div className="flex items-center gap-2">
                                <div className="flex-1">
                                    <Problem text={error} />
                                </div>
                                <button
                                    type="button"
                                    onClick={clearError}
                                    className="cursor-pointer text-xs text-muted hover:text-primary"
                                >
                                    Dismiss
                                </button>
                            </div>
                        ) : null}
                    </>
                }
                aside={
                    <>
                        {pipeline ? (
                            <ReleaseRunSection
                                dir={project.dir}
                                projectName={projectName}
                                pipeline={pipeline}
                                runs={runs}
                                session={releaseSession}
                                onEnded={reloadRelease}
                            />
                        ) : null}
                        {lastBuild && !lastBuild.closed ? (
                            <BuildRunCard
                                run={lastBuild}
                                projectName={projectName}
                                phases={buildDef?.phases ?? []}
                                manifest={delivered}
                                onRetry={() => start("build", lastBuild.stepid)}
                            />
                        ) : null}
                    </>
                }
                git={git}
                github={github}
            />
            {prompt}
        </>
    );
}

function TimelineBody({
    days,
    header,
    banner,
    aside,
    git,
    github,
}: {
    days: number;
    header: React.ReactNode;
    banner: React.ReactNode;
    aside?: React.ReactNode;
    git: MissionGit;
    github: MissionGithub;
}) {
    const tree = useMemo(() => (git ? toTreeData(git) : null), [git]);
    const state = useMemo(
        () => (tree ? releaseState(tree.tags, git.ahead ?? [], git.sincepublic ?? []) : null),
        [tree, git]
    );
    const prs = useMemo(() => prsByBranch(github?.prs), [github?.prs]);
    return (
        <>
            {header}
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
                {banner}
                {git?.fetcherror ? (
                    <Notice text={`Showing the local state: fetching from the remote failed (${git.fetcherror}).`} />
                ) : null}
                <div className="grid min-h-[520px] flex-1 gap-3 @3xl:grid-cols-[minmax(0,1fr)_340px]">
                    <div className="min-h-[520px] rounded border border-border">
                        {tree ? (
                            <BranchTree data={tree} days={days} prs={prs} />
                        ) : (
                            <div className="h-full w-full animate-pulse bg-hover/40" />
                        )}
                    </div>
                    <div className="flex min-w-0 flex-col gap-3">
                        {aside}
                        <ReleaseStatePanel
                            state={state}
                            milestones={github?.milestones}
                            trunk={git?.trunk}
                            release={git?.release}
                        />
                    </div>
                </div>
            </div>
        </>
    );
}
