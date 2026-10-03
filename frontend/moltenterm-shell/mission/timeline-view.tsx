// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Mission Control's Timeline panel (FR-MC-002), modelled on Notulia's Dev › Timeline: the branches as a tree beside
// where the releases stand, with the Build local and Release menus in its header.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { cn } from "@/util/util";
import { atom } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { pathBaseName } from "../workspace-project";
import { BranchTree } from "./branch-tree";
import { BuildLocalMenu } from "./build-local-menu";
import { Notice, Problem } from "./cicd-panels";
import { useMissionRuns } from "./mission-client";
import { ActiveProject, MissionFrame, MissionHeader, PipelineBanner } from "./mission-frame";
import { latestRun, MissionGit, MissionGithub, MissionSnapshot, prsByBranch, toTreeData } from "./mission-model";
import { ReleaseStatePanel } from "./release-state-panel";
import { BuildRunCard, useStartRun } from "./runs-view";
import { nextRc, releaseState } from "./versions";

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

type MenuItem = { label: string; detail?: string; disabled: boolean; onClick?: () => void };

function HeaderMenu({ icon, label, items, note }: { icon: string; label: string; items: MenuItem[]; note: string }) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) {
            return;
        }
        const close = (e: PointerEvent) => {
            if (!ref.current?.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("pointerdown", close, true);
        return () => document.removeEventListener("pointerdown", close, true);
    }, [open]);
    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="flex cursor-pointer items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-secondary hover:bg-hover hover:text-primary"
            >
                <i className={cn("fa fa-solid text-[10px]", `fa-${icon}`)} />
                {label}
                <i className="fa fa-solid fa-chevron-down text-[9px]" />
            </button>
            {open ? (
                <div className="absolute top-full right-0 z-20 mt-1 w-72 rounded border border-border bg-modalbg p-1 shadow-lg">
                    {items.map((item) => (
                        <button
                            type="button"
                            key={item.label}
                            disabled={item.disabled}
                            onClick={() => {
                                setOpen(false);
                                item.onClick?.();
                            }}
                            className={cn(
                                "flex w-full flex-col rounded px-2 py-1.5 text-left text-xs",
                                item.disabled ? "text-muted" : "cursor-pointer text-primary hover:bg-hover"
                            )}
                        >
                            <span className="font-medium">{item.label}</span>
                            {item.detail ? <span className="text-[11px] text-muted">{item.detail}</span> : null}
                        </button>
                    ))}
                    {note ? (
                        <div className="mt-1 border-t border-border px-2 pt-1.5 pb-1 text-[11px] text-muted">
                            {note}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
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
    const showRun = () => document.querySelector(`[data-testid="build-run"]`)?.scrollIntoView({ block: "nearest" });
    const rcSteps = pipeline?.release?.rc ?? [];
    const publicSteps = pipeline?.release?.public ?? [];
    const releaseNote = pipeline
        ? "Declared in the pipeline; running releases from here is coming next."
        : "Needs the project's pipeline: connect it first (see the banner).";
    return (
        <>
            <TimelineBody
                days={days}
                header={(state) => (
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
                        <HeaderMenu
                            icon="rocket"
                            label="Release"
                            note={releaseNote}
                            items={[
                                {
                                    label: state?.rcTag ? `Release candidate ${state.rcTag}` : "Release candidate",
                                    detail: rcSteps.length
                                        ? rcSteps.map((st) => st.title || st.id).join(" → ")
                                        : "not declared by the pipeline",
                                    disabled: true,
                                },
                                {
                                    label: state?.publicTag ? `Public release ${state.publicTag}` : "Public release",
                                    detail: publicSteps.length
                                        ? publicSteps.map((st) => st.title || st.id).join(" → ")
                                        : "not declared by the pipeline",
                                    disabled: true,
                                },
                            ]}
                        />
                    </MissionHeader>
                )}
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
                    lastBuild && !lastBuild.closed ? (
                        <BuildRunCard run={lastBuild} onRetry={() => start("build", lastBuild.stepid)} />
                    ) : null
                }
                git={git}
                github={github}
            />
            {prompt}
        </>
    );
}

type TimelineHeaderState = { rcTag: string; publicTag: string };

function TimelineBody({
    days,
    header,
    banner,
    aside,
    git,
    github,
}: {
    days: number;
    header: (state: TimelineHeaderState) => React.ReactNode;
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
    const headerState = useMemo<TimelineHeaderState>(() => {
        if (state == null) {
            return null;
        }
        const version = state.next.version;
        if (version == null) {
            return { rcTag: null, publicTag: null };
        }
        try {
            const rc = nextRc(
                version,
                tree.tags.map((t) => t.name)
            );
            return { rcTag: `v${version}-${rc}`, publicTag: `v${version}` };
        } catch {
            return { rcTag: null, publicTag: `v${version}` };
        }
    }, [state, tree]);
    return (
        <>
            {header(headerState)}
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
