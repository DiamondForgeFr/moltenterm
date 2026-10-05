// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project overview's own cards (FR-MC-020, DS-MC-012), composed from Mission Control's panels, one home for each
// piece of information: the actions in the header band (Run CI, Build local, Release, Clean branches, each showing
// its plan before it runs), the branches on the line map, then four cards: Next public release, Releases, Now (what
// runs, the CI on the trunk, the last build, the agents) and Project steps. They register like any contribution.

import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { isMacOS } from "@/util/platformutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { AgentStateDotClasses, AgentStateInfo, agentStateLabel, agentStateTitle } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { AdapterSteps } from "../mission/adapter-steps";
import { BranchCleanupButton } from "../mission/branch-cleanup";
import { BranchTree, timeAgo } from "../mission/branch-tree";
import { BuildLocalMenu } from "../mission/build-local-menu";
import {
    formatElapsed,
    latestRun,
    MissionSnapshot,
    prsByBranch,
    RunStateLabels,
    toTreeData,
} from "../mission/mission-model";
import { ReleaseMenu } from "../mission/release-menu";
import { ReleaseRunSection } from "../mission/release-run-panel";
import { NextPublicRelease, ReleaseHistory } from "../mission/release-state-panel";
import { BuildRunCard, useDeliveredManifest } from "../mission/runs-view";
import { releaseState, treeRules } from "../mission/versions";
import { MoltentermNotifications } from "../notifications-store";
import { usePaneStatus } from "../pane-status";
import { blockFolder, ciVerdictView, makePaneView } from "../status-bar-model";
import { ProjectCard } from "./project-cards";
import { ProjectCardProps } from "./project-context";
import { projectWork, workspaceAgents } from "./project-model";

const MaxAgentsShown = 5;

// The Timeline's period choices; the line map (FR-MC-022) replaces them with its own time window.
const DayChoices = [7, 21, 60, 180];

const AgentStateText: Record<string, string> = {
    waiting: "text-warning",
    error: "text-error",
    working: "text-accent",
    done: "text-success",
    idle: "text-muted",
};

const QuietButton =
    "flex cursor-pointer items-center gap-1.5 rounded border border-border px-2 py-1 text-xs whitespace-nowrap text-secondary transition-colors hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

function paletteShortcut(): string {
    return isMacOS() ? "⌘⇧K" : "Ctrl+Shift+K";
}

function Line({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
    return (
        <div className="flex min-w-0 items-baseline gap-2 py-0.5 text-xs" title={title}>
            <span className="w-20 shrink-0 text-muted">{label}</span>
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">{children}</span>
        </div>
    );
}

function SubHeading({ children }: { children: React.ReactNode }) {
    return <div className="text-[11px] text-muted">{children}</div>;
}

function useReleaseState(snapshot: MissionSnapshot) {
    const git = snapshot?.git;
    const tree = useMemo(() => (git ? toTreeData(git) : null), [git]);
    const state = useMemo(
        () => (tree ? releaseState(tree.tags, git.ahead ?? [], git.sincepublic ?? [], treeRules(tree)) : null),
        [tree, git]
    );
    return { tree, state };
}

function AgentLine({ info }: { info: AgentStateInfo }) {
    const [block] = useWaveObjectValue<Block>(makeORef("block", info.blockid));
    const meta = block?.meta;
    const folder = blockFolder({ view: meta?.view, connection: meta?.connection, "cmd:cwd": meta?.["cmd:cwd"] });
    const paneState = usePaneStatus(folder, null);
    const branch = folder ? makePaneView(folder, paneState, null).branch : "";
    const goTo = () =>
        MoltentermNotifications.getInstance().goTo({
            workspaceid: info.workspaceid,
            tabid: info.tabid,
            blockid: info.blockid,
        });
    return (
        <button
            type="button"
            onClick={goTo}
            title={`${agentStateTitle(info)}\nClick to go to its pane`}
            className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-hover"
            data-testid="project-agent"
        >
            <span
                className={cn(
                    "inline-block h-2 w-2 shrink-0 rounded-full",
                    AgentStateDotClasses[info.state] ?? AgentStateDotClasses.idle,
                    info.state === "working" && "animate-pulse motion-reduce:animate-none"
                )}
                aria-hidden
            />
            <span className="shrink-0 font-medium text-primary">{info.agentname || info.agent || "Agent"}</span>
            <span className={cn("shrink-0", AgentStateText[info.state] ?? "text-muted")}>
                {agentStateLabel(info.state)}
            </span>
            {branch ? <span className="min-w-0 truncate text-muted">{branch}</span> : null}
        </button>
    );
}

function Agents({ workspaceId }: { workspaceId: string }) {
    const data = useAtomValue(AgentStates.getInstance().dataAtom);
    const agents = useMemo(() => workspaceAgents(data.states, workspaceId), [data, workspaceId]);
    if (agents.length === 0) {
        return (
            <p className="text-xs text-muted">
                No coding agent in this workspace. Start one from the palette ({paletteShortcut()}).
            </p>
        );
    }
    return (
        <div className="-mx-1 flex flex-col" data-testid="project-agents">
            {agents.slice(0, MaxAgentsShown).map((info) => (
                <AgentLine key={info.blockid} info={info} />
            ))}
            {agents.length > MaxAgentsShown ? (
                <span className="px-1 pt-0.5 text-[11px] text-muted">and {agents.length - MaxAgentsShown} more</span>
            ) : null}
        </div>
    );
}

function useNow(active: boolean): number {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!active) {
            return;
        }
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") {
                setNow(Date.now());
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [active]);
    return now;
}

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

function LineMapCard({ snapshot }: ProjectCardProps) {
    const [days, setDays] = useState(21);
    const git = snapshot?.git;
    const tree = useMemo(() => (git ? toTreeData(git) : null), [git]);
    const prs = useMemo(() => prsByBranch(snapshot?.github?.prs), [snapshot?.github?.prs]);
    return (
        <section className="flex flex-col gap-2" aria-label="Line map" data-testid="project-linemap">
            <div className="flex items-center gap-3">
                <span className="text-[11px] font-medium tracking-wide text-secondary uppercase">
                    Line · last {days} days
                </span>
                <span className="flex-1" />
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
            </div>
            <div className="h-[440px] rounded border border-border">
                {tree ? (
                    <BranchTree data={tree} days={days} prs={prs} />
                ) : (
                    <div className="h-full w-full animate-pulse bg-hover/40" aria-busy="true" />
                )}
            </div>
        </section>
    );
}

function NextReleaseCard({ snapshot }: ProjectCardProps) {
    const { tree, state } = useReleaseState(snapshot);
    return (
        <div className="p-3">
            <NextPublicRelease
                state={state}
                milestones={snapshot?.github?.milestones}
                trunk={snapshot?.git?.trunk}
                release={snapshot?.git?.release}
                tagPrefix={tree?.tagPrefix}
            />
        </div>
    );
}

function ReleasesCard({ snapshot }: ProjectCardProps) {
    const { tree, state } = useReleaseState(snapshot);
    return (
        <div className="p-3">
            <ReleaseHistory state={state} tagPrefix={tree?.tagPrefix} />
        </div>
    );
}

// What runs now: the work in progress, the local CI on the trunk, the release under way and the last build (one card
// for it: its panel while open, else one line), then the workspace's agents.
function NowCard({
    project,
    projectName,
    pipeline,
    runs,
    ci,
    release,
    reloadRelease,
    startBuild,
    snapshot,
}: ProjectCardProps) {
    const lastBuild = latestRun(runs, "build");
    const delivered = useDeliveredManifest(project.dir, lastBuild);
    const buildDef = (pipeline?.builds ?? []).find((b) => b.id === lastBuild?.stepid);
    const showBuild = lastBuild != null && !lastBuild.closed;
    const work = useMemo(
        () => projectWork(ci, runs, release).filter((item) => !(showBuild && item.kind === "build")),
        [ci, runs, release, showBuild]
    );
    const now = useNow(work.length > 0);
    const trunk = snapshot?.git?.trunk;
    const trunkVerdict = ciVerdictView((ci?.branches ?? []).find((b) => b.name === trunk)?.verdict);
    return (
        <div className="flex flex-col gap-3 p-3" data-testid="project-now">
            <div className="flex flex-col" data-testid="project-work">
                {work.map((item) => (
                    <div key={item.id} className="flex min-w-0 items-baseline gap-2 py-0.5 text-xs">
                        <i className="fa fa-solid fa-circle-notch fa-spin w-3 shrink-0 text-[10px] text-accent" />
                        <span className="min-w-0 truncate text-primary">{item.label}</span>
                        {item.detail ? <span className="shrink-0 text-muted">{item.detail}</span> : null}
                        <span className="ml-auto shrink-0 text-muted tabular-nums">
                            {formatElapsed(now - item.startedat)}
                        </span>
                    </div>
                ))}
                {work.length === 0 && !showBuild ? <p className="py-0.5 text-xs text-muted">Nothing running.</p> : null}
                {trunk ? (
                    <Line label={`CI ${trunk}`}>
                        {trunkVerdict ? (
                            <>
                                <i className={cn("fa fa-solid text-[11px]", trunkVerdict.iconClass)} />
                                <span className="text-secondary">{trunkVerdict.label}</span>
                            </>
                        ) : (
                            <span className="text-muted">not known yet</span>
                        )}
                    </Line>
                ) : null}
                {lastBuild && !showBuild ? (
                    <Line label="Last build">
                        <span className="truncate text-secondary">{lastBuild.title || lastBuild.stepid}</span>
                        <span
                            className={cn(
                                lastBuild.state === "success" && "text-success",
                                lastBuild.state === "failure" && "text-error",
                                lastBuild.state !== "success" && lastBuild.state !== "failure" && "text-muted"
                            )}
                        >
                            {RunStateLabels[lastBuild.state]}
                        </span>
                        {lastBuild.finishedat ? (
                            <span className="text-muted">{timeAgo(new Date(lastBuild.finishedat).toISOString())}</span>
                        ) : null}
                    </Line>
                ) : null}
            </div>
            {pipeline ? (
                <ReleaseRunSection
                    dir={project.dir}
                    projectName={projectName}
                    pipeline={pipeline}
                    runs={runs}
                    session={release}
                    onEnded={reloadRelease}
                />
            ) : null}
            {showBuild ? (
                <BuildRunCard
                    run={lastBuild}
                    projectName={projectName}
                    phases={buildDef?.phases ?? []}
                    manifest={delivered}
                    onRetry={() => fireAndForget(() => startBuild(lastBuild.stepid))}
                />
            ) : null}
            <div className="flex flex-col gap-1 border-t border-border pt-2">
                <SubHeading>Agents</SubHeading>
                <Agents workspaceId={project.workspace?.oid} />
            </div>
        </div>
    );
}

function StepsCard({ project, projectName, pipeline, runs }: ProjectCardProps) {
    const declared = (pipeline?.steps ?? []).some((s) => s.section === "timeline");
    if (!declared) {
        return (
            <p className="p-3 text-xs text-muted">
                {pipeline
                    ? 'No project step for the overview: the pipeline declares none in its "timeline" section.'
                    : "The project's own steps show here once the pipeline is connected."}
            </p>
        );
    }
    return (
        <div data-testid="project-steps">
            <AdapterSteps
                dir={project.dir}
                projectName={projectName}
                pipeline={pipeline}
                runs={runs}
                section="timeline"
                bare={true}
            />
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
