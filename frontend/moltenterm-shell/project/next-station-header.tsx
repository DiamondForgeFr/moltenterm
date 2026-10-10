// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project overview's header band (FR-MC-021), a passenger information screen: the next station and its state,
// what waits on the trunk, Mission Control's only copy of the actions (Run CI on develop, Build local, Release, Clean
// branches), and a fixed list of the latest pending changes. What it shows comes from next-station-model.ts.

import { openLink } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useMemo } from "react";
import { ActionPrimaryClass, RunningDot } from "../mission/action-button";
import { BranchCleanupButton } from "../mission/branch-cleanup";
import { BuildLocalMenu } from "../mission/build-local-menu";
import { latestRun } from "../mission/mission-model";
import { ReleaseMenu } from "../mission/release-menu";
import { MoltenWave } from "../molten-button";
import { WorkspaceIcon } from "../workspace-icon";
import { WorkspaceIconSource, workspaceIconSource } from "../workspace-icon-model";
import {
    countsLine,
    nextStation,
    NextStationState,
    runCiTarget,
    TickerItem,
    tickerItems,
    waitingCounts,
} from "./next-station-model";
import { ProjectCardProps } from "./project-context";

const LatestShown = 3;

// Only a decision asks for something: it gets the warning tone, the other states stay calm.
const ChipClass: Record<NextStationState, string> = {
    decision: "border-warning/50 bg-warning/10 text-warning",
    chosen: "border-accent/50 bg-[color-mix(in_srgb,var(--mt-accent)_10%,transparent)] text-primary",
    derived: "border-border text-secondary",
    nothing: "border-border text-muted",
};

function Eyebrow({ children }: { children: React.ReactNode }) {
    return <span className="text-11 font-semibold tracking-[0.14em] text-muted uppercase">{children}</span>;
}

// The workspace's badge, as the rail shows it (FR-SHELL-031 AC8); the project's initial only when there is no
// workspace to take it from.
function ProjectBadge({ name, source }: { name: string; source: WorkspaceIconSource }) {
    if (source.image || source.logo || source.icon) {
        return (
            <span
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-10 border border-border bg-hover text-icon-20"
                aria-hidden
            >
                <WorkspaceIcon source={source} />
            </span>
        );
    }
    return (
        <span
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-10 bg-[var(--mt-accent)] text-20 leading-none font-semibold text-[var(--mt-accent-fg)]"
            aria-hidden
        >
            {(name || "?").slice(0, 1).toUpperCase()}
        </span>
    );
}

function ChangeText({ item }: { item: TickerItem }) {
    return (
        <>
            {item.ticket ? <span className="mr-1.5 text-[var(--mt-accent)]">#{item.ticket}</span> : null}
            {item.text}
        </>
    );
}

// The latest changes waiting on the trunk, newest first, as a fixed list (FR-SHELL-057, DS-SHELL-099): nothing moves
// by itself; the Waiting count above says how many there are in all.
function LatestChanges({ items, trunk, total }: { items: TickerItem[]; trunk: string; total: number }) {
    const shown = items.slice(0, LatestShown);
    // The items stop at the ticker cap; the Waiting count above holds them all.
    const more = Math.max(total ?? 0, items.length) - shown.length;
    return (
        <section
            aria-label={`Latest changes waiting on ${trunk}`}
            className="flex flex-col gap-1 border-t border-border bg-background/60 px-4 py-2 @min-[42rem]:px-6"
            data-testid="next-station-latest"
        >
            <Eyebrow>Latest on {trunk}</Eyebrow>
            <ul className="flex min-w-0 flex-col text-12 text-secondary">
                {shown.map((item) => (
                    <li key={item.key} className="flex h-6 min-w-0 items-center">
                        {item.url ? (
                            <a
                                href={item.url}
                                onClick={(e) => {
                                    e.preventDefault();
                                    fireAndForget(() => openLink(item.url));
                                }}
                                className="min-w-0 cursor-pointer truncate rounded-4 hover:text-primary"
                                title={`Open #${item.ticket} on GitHub`}
                            >
                                <ChangeText item={item} />
                            </a>
                        ) : (
                            <span className="min-w-0 truncate" title={item.text}>
                                <ChangeText item={item} />
                            </span>
                        )}
                    </li>
                ))}
            </ul>
            {more > 0 ? (
                <span className="text-11 text-muted">
                    and {more} more change{more === 1 ? "" : "s"}
                </span>
            ) : null}
        </section>
    );
}

export function NextStationHeader({
    project,
    projectName,
    snapshot,
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
    const git = snapshot?.git;
    const station = useMemo(() => nextStation(git, release), [git, release]);
    const counts = useMemo(() => waitingCounts(git), [git]);
    const items = useMemo(() => tickerItems(git), [git]);
    const target = runCiTarget(git, pipeline, ci);
    const lastBuild = latestRun(runs, "build");
    const iconSource = workspaceIconSource(project.workspace);
    const trunk = git?.trunk || "develop";
    return (
        <div className="flex flex-col" data-testid="next-station">
            <div className="h-1 bg-[var(--mt-accent)]" aria-hidden />
            <div className="flex flex-wrap items-center gap-x-7 gap-y-4 px-4 py-4 @min-[42rem]:px-6">
                <div className="flex min-w-0 items-center gap-x-7 gap-y-4 @max-[30rem]:flex-wrap">
                    <ProjectBadge name={projectName} source={iconSource} />
                    <div className="flex min-w-0 flex-col gap-0.5" data-testid="next-station-version">
                        <Eyebrow>Next station</Eyebrow>
                        <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
                            <span className="text-32 leading-none font-semibold tracking-tight text-primary">
                                {station?.tag ?? (station ? "Nothing yet" : "…")}
                            </span>
                            {station?.chip ? (
                                <span
                                    className={cn(
                                        "rounded-4 border px-2 py-0.5 text-12 font-semibold",
                                        ChipClass[station.state]
                                    )}
                                    data-testid="next-station-state"
                                >
                                    {station.chip}
                                </span>
                            ) : null}
                        </div>
                        <span className="text-13 text-secondary">{station?.note ?? "Reading the history…"}</span>
                    </div>
                </div>
                <div className="hidden w-px self-stretch bg-border @min-[42rem]:block" aria-hidden />
                <div className="flex min-w-0 flex-col gap-0.5" data-testid="next-station-waiting">
                    <Eyebrow>{counts?.title ?? `Waiting on ${trunk}`}</Eyebrow>
                    <div className="flex items-baseline gap-2.5">
                        <span className="text-32 leading-none font-semibold text-[var(--mt-accent)] tabular-nums">
                            {counts?.total ?? "…"}
                        </span>
                        <span className="text-13 leading-5 text-secondary">{counts?.scope ?? ""}</span>
                    </div>
                    <span className="text-13 text-secondary" data-testid="next-station-counts">
                        {countsLine(counts)}
                    </span>
                </div>
                <div
                    className="flex w-full flex-wrap gap-2 @min-[64rem]:ml-auto @min-[64rem]:w-auto @min-[64rem]:max-w-[520px] @min-[64rem]:justify-end"
                    data-testid="project-actions"
                >
                    {target.running ? (
                        <button
                            type="button"
                            className={ActionPrimaryClass}
                            onClick={showRuns}
                            title={`The local CI runs on ${target.branch}: show it`}
                        >
                            <RunningDot className="text-current" />
                            CI on {target.branch}…
                            <MoltenWave />
                        </button>
                    ) : (
                        <button
                            type="button"
                            className={ActionPrimaryClass}
                            disabled={target.disabled != null}
                            onClick={() => runCi(target.branch)}
                            title={target.disabled ?? `Run the local CI on ${target.branch}, whatever is checked out`}
                        >
                            <i className="fa fa-solid fa-play text-11" />
                            Run CI on {target.branch || trunk}
                            <MoltenWave />
                        </button>
                    )}
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
                    {pipeline ? null : (
                        <p className="basis-full text-11 text-muted @min-[64rem]:text-right">
                            Build local and Release appear once the pipeline is connected.
                        </p>
                    )}
                </div>
            </div>
            {items.length > 0 ? <LatestChanges items={items} trunk={trunk} total={counts?.total} /> : null}
        </div>
    );
}
