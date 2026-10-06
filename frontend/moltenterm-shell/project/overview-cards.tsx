// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The row of four cards under the line map (FR-MC-024, DS-MC-012), each the only home of its summary: Next public
// release (what waits on the trunk, by kind, and the milestone), Releases (the last release candidate and the last
// public release), Now (the CI on the trunk, the last local build, what else runs, the agents) and Project steps (the
// pipeline's overview steps, FR-MC-018). They are contributions like a mod's card (project-builtin-cards.tsx).

import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { isMacOS } from "@/util/platformutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { AgentStateDotClasses, AgentStateInfo, agentStateLabel, agentStateTitle } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { AdapterSteps } from "../mission/adapter-steps";
import { latestRun, MissionSnapshot, toTreeData } from "../mission/mission-model";
import { ReleaseRunSection } from "../mission/release-run-panel";
import { NextPublicRelease, ReleaseHistory } from "../mission/release-state-panel";
import { BuildRunCard, useDeliveredManifest } from "../mission/runs-view";
import { releaseState, treeRules } from "../mission/versions";
import { MoltentermNotifications } from "../notifications-store";
import { usePaneStatus } from "../pane-status";
import { blockFolder, makePaneView } from "../status-bar-model";
import {
    CardTone,
    clockElapsed,
    lastBuildLine,
    nextReleaseView,
    NowLine,
    releasesView,
    trunkCiLine,
} from "./overview-cards-model";
import { ProjectCardProps } from "./project-context";
import { projectWork, workspaceAgents } from "./project-model";

// The overview section of the pipeline's steps; must match PipelineSections in pkg/molten/pipeline.go.
const OverviewSection = "timeline";
const MaxAgentsShown = 5;

const ToneDot: Record<CardTone, string> = {
    running: "bg-[var(--mt-state-working)]",
    success: "bg-success",
    failure: "bg-error",
    neutral: "bg-muted",
};

const ToneText: Record<CardTone, string> = {
    running: "text-[var(--mt-state-working)]",
    success: "text-success",
    failure: "text-error",
    neutral: "text-muted",
};

const AgentStateText: Record<string, string> = {
    waiting: "text-warning",
    error: "text-error",
    working: "text-[var(--mt-state-working)]",
    done: "text-success",
    idle: "text-muted",
};

function paletteShortcut(): string {
    return isMacOS() ? "⌘⇧K" : "Ctrl+Shift+K";
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

// A clock that ticks once a second while something runs and the tab is visible.
function useNow(active: boolean): number {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!active) {
            return;
        }
        setNow(Date.now());
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") {
                setNow(Date.now());
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [active]);
    return now;
}

function Dot({ tone, className }: { tone: CardTone; className?: string }) {
    return (
        <span
            className={cn(
                "inline-block h-2 w-2 shrink-0 rounded-full",
                ToneDot[tone],
                tone === "running" && "animate-pulse motion-reduce:animate-none",
                className
            )}
            aria-hidden
        />
    );
}

function StatusLine({ line, testId }: { line: NowLine; testId: string }) {
    return (
        <div className="flex min-w-0 items-center gap-2.5 text-[13px]" title={line.title} data-testid={testId}>
            <Dot tone={line.tone} />
            <span className="min-w-0 flex-1 truncate text-primary">{line.label}</span>
            {line.text ? (
                <span className={cn("shrink-0 font-mono text-xs tabular-nums", ToneText[line.tone])}>{line.text}</span>
            ) : null}
        </div>
    );
}

function SubHeading({ children }: { children: React.ReactNode }) {
    return <span className="text-xs text-muted">{children}</span>;
}

export function NextReleaseCard({ snapshot }: ProjectCardProps) {
    const { state } = useReleaseState(snapshot);
    const github = snapshot?.github;
    const view = useMemo(
        () => nextReleaseView(state, snapshot?.git, github?.milestones, github?.state),
        [state, snapshot?.git, github]
    );
    return <NextPublicRelease view={view} />;
}

export function ReleasesCard({ snapshot }: ProjectCardProps) {
    const { tree, state } = useReleaseState(snapshot);
    const view = useMemo(() => releasesView(state, tree?.tagPrefix), [state, tree?.tagPrefix]);
    return <ReleaseHistory view={view} />;
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
            className="-mx-1 flex min-w-0 cursor-pointer items-center gap-2.5 rounded px-1 py-0.5 text-left text-[13px] hover:bg-hover"
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
            <span className="min-w-0 flex-1 truncate text-primary">{info.agentname || info.agent || "Agent"}</span>
            <span
                className={cn(
                    "max-w-[55%] shrink-0 truncate font-mono text-xs",
                    AgentStateText[info.state] ?? "text-muted"
                )}
            >
                {agentStateLabel(info.state)}
                {branch ? <span className="text-muted"> · {branch}</span> : null}
            </span>
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
        <div className="flex flex-col" data-testid="project-agents">
            {agents.slice(0, MaxAgentsShown).map((info) => (
                <AgentLine key={info.blockid} info={info} />
            ))}
            {agents.length > MaxAgentsShown ? (
                <span className="pt-0.5 text-[11px] text-muted">and {agents.length - MaxAgentsShown} more</span>
            ) : null}
        </div>
    );
}

// What runs now: the CI on the trunk, the last local build (its card while open, else one line), the release under
// way and anything else running, then the workspace's agents.
export function NowCard({
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
    const trunk = snapshot?.git?.trunk;
    const lastBuild = latestRun(runs, "build");
    const delivered = useDeliveredManifest(project.dir, lastBuild);
    const buildDef = (pipeline?.builds ?? []).find((b) => b.id === lastBuild?.stepid);
    const showBuild = lastBuild != null && !lastBuild.closed;
    const showRelease = pipeline != null;
    const ciOnTrunk = !!ci?.running && (ci.runs ?? []).find((r) => r.id === ci.running)?.branch === trunk;
    // The trunk's CI, the build and the release have their own lines or panels; the rest of what runs is listed.
    const work = useMemo(
        () =>
            projectWork(ci, runs, release).filter(
                (item) =>
                    item.kind !== "build" &&
                    !(showRelease && item.kind === "release") &&
                    !(ciOnTrunk && item.kind === "ci")
            ),
        [ci, runs, release, showRelease, ciOnTrunk]
    );
    const ticking = !!ci?.running || lastBuild?.state === "running" || work.length > 0;
    const now = useNow(ticking);
    const ciLine = trunkCiLine(ci, trunk, now);
    return (
        <div className="flex flex-col gap-3" data-testid="project-now">
            <div className="flex flex-col gap-2">
                {ciLine ? <StatusLine line={ciLine} testId="project-now-ci" /> : null}
                {showBuild ? null : <StatusLine line={lastBuildLine(lastBuild, now)} testId="project-now-build" />}
                {work.map((item) => (
                    <div
                        key={item.id}
                        className="flex min-w-0 items-center gap-2.5 text-[13px]"
                        data-testid="project-work"
                    >
                        <Dot tone="running" />
                        <span className="min-w-0 flex-1 truncate text-primary">
                            {item.label}
                            {item.detail ? <span className="text-muted"> · {item.detail}</span> : null}
                        </span>
                        <span className="shrink-0 font-mono text-xs text-[var(--mt-state-working)] tabular-nums">
                            {clockElapsed(now - item.startedat)}
                        </span>
                    </div>
                ))}
            </div>
            {showRelease ? (
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
            <div className="h-px bg-border" />
            <div className="flex flex-col gap-1.5">
                <SubHeading>Agents</SubHeading>
                <Agents workspaceId={project.workspace?.oid} />
            </div>
        </div>
    );
}

export function StepsCard({ project, projectName, pipeline, runs }: ProjectCardProps) {
    const declared = (pipeline?.steps ?? []).some((s) => s.section === OverviewSection);
    if (!declared) {
        return (
            <p className="text-xs text-muted">
                {pipeline
                    ? `No project step for the overview: the pipeline declares none in its "${OverviewSection}" section.`
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
                section={OverviewSection}
                bare={true}
            />
        </div>
    );
}
