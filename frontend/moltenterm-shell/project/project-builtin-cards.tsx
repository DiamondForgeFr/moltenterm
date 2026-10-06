// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project overview's own cards (FR-MC-020, DS-MC-012), composed from Mission Control's panels, one home for each
// piece of information: the actions in the header band (Run CI, Build local, Release, Clean branches, each showing
// its plan before it runs), the branches on the line map, then the row of four cards (overview-cards.tsx): Next public
// release, Releases, Now and Project steps. They register like any contribution.

import { BranchCleanupButton } from "../mission/branch-cleanup";
import { BuildLocalMenu } from "../mission/build-local-menu";
import { latestRun } from "../mission/mission-model";
import { ReleaseMenu } from "../mission/release-menu";
import { LineMapCard } from "./line-map-card";
import { NextReleaseCard, NowCard, ReleasesCard, StepsCard } from "./overview-cards";
import { ProjectCard } from "./project-cards";
import { ProjectCardProps } from "./project-context";

const QuietButton =
    "flex cursor-pointer items-center gap-1.5 rounded border border-border px-2 py-1 text-xs whitespace-nowrap text-secondary transition-colors hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

function ActionsCard({
    project,
    projectName,
    pipeline,
    runs,
    ci,
    release,
    reloadRelease,
    refresh,
    startBuild,
    runCi,
    showRuns,
}: ProjectCardProps) {
    const lastBuild = latestRun(runs, "build");
    const current = ci?.current;
    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="project-actions">
            <div className="flex flex-wrap gap-2">
                <button
                    type="button"
                    className={QuietButton}
                    disabled={!!ci?.running || (pipeline?.ci?.jobs ?? []).length === 0}
                    onClick={() => runCi(current ?? "")}
                    title={
                        (pipeline?.ci?.jobs ?? []).length === 0
                            ? "The pipeline declares no CI job"
                            : `Run the local CI on ${current || "HEAD"}`
                    }
                >
                    <i className="fa fa-solid fa-list-check text-[10px]" />
                    Run CI{current ? ` on ${current}` : ""}
                </button>
                {pipeline ? (
                    <BuildLocalMenu
                        dir={project.dir}
                        projectName={projectName}
                        running={lastBuild?.state === "running" ? lastBuild : null}
                        onBuild={startBuild}
                        onShowRun={showRuns}
                    />
                ) : null}
                {pipeline ? (
                    <ReleaseMenu
                        dir={project.dir}
                        projectName={projectName}
                        session={release}
                        rcSteps={pipeline.release?.rc ?? []}
                        publicSteps={pipeline.release?.public ?? []}
                        onStarted={() => {
                            reloadRelease();
                            showRuns();
                        }}
                        onShowRelease={showRuns}
                    />
                ) : null}
                <BranchCleanupButton dir={project.dir} onCleaned={refresh} />
            </div>
            <p className="text-[11px] text-muted">
                {pipeline
                    ? "Build local, Release and Clean branches show what they will do first; nothing runs before you confirm."
                    : "Build local and Release appear once the pipeline is connected. Clean branches shows what would go first."}
            </p>
        </div>
    );
}

// The header and map slots frame themselves; the four cards of the row get the core's frame with their title.
export const BuiltinProjectCards: ProjectCard<ProjectCardProps>[] = [
    { id: "moltenterm:actions", title: "Actions", region: "header", order: 10, bare: true, component: ActionsCard },
    { id: "moltenterm:linemap", title: "Line map", region: "map", order: 10, bare: true, component: LineMapCard },
    {
        id: "moltenterm:next-release",
        title: "Next public release",
        region: "cards",
        order: 10,
        component: NextReleaseCard,
    },
    { id: "moltenterm:releases", title: "Releases", region: "cards", order: 20, component: ReleasesCard },
    { id: "moltenterm:now", title: "Now", region: "cards", order: 30, component: NowCard },
    { id: "moltenterm:steps", title: "Project steps", region: "cards", order: 40, component: StepsCard },
];
