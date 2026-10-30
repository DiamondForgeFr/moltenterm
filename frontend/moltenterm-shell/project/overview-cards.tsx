// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The row of four cards under the line map (FR-MC-024, DS-MC-012), each the only home of its summary: Next public
// release (what waits on the trunk, by kind, and the milestone), Releases (the last release candidate and the last
// public release), Now (the CI on the trunk, the last local build, what else runs, the agents) and Project steps (the
// pipeline's overview steps, FR-MC-018). They are contributions like a mod's card (project-builtin-cards.tsx).

import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import {
    agentCallName,
    agentLabel,
    AgentStateDotClasses,
    AgentStateInfo,
    agentStateLabel,
    agentStateTitle,
} from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { agentWorkText, batchOriginOf } from "../agent-work-model";
import { useCompanionFollow } from "../companion/companion-follow";
import { useLocale, useT } from "../i18n/i18n";
import { AdapterSteps } from "../mission/adapter-steps";
import { latestRun, MissionSnapshot, toTreeData } from "../mission/mission-model";
import { ReleaseRunSection } from "../mission/release-run-panel";
import { NextPublicRelease, ReleaseHistory } from "../mission/release-state-panel";
import { BuildRunCard, useDeliveredManifest } from "../mission/runs-view";
import { releaseState, treeRules } from "../mission/versions";
import { MoltentermNotifications } from "../notifications-store";
import { usePaneStatus } from "../pane-status";
import { useBatchRun } from "../reviews/reviews-batch-client";
import { formatShortcutById } from "../shortcuts/format";
import { blockFolder, makePaneView } from "../status-bar-model";
import { TabActivity, whileShown } from "../tab-activity";
import { useWorkingBeat } from "../working-beat";
import {
    CardTone,
    clockElapsed,
    lastBuildLine,
    MaxSubagentsShown,
    nextReleaseView,
    NowLine,
    nowSubagents,
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
    failure: "text-danger",
    neutral: "text-muted",
};

const AgentStateText: Record<string, string> = {
    waiting: "text-[var(--mt-state-waiting)]",
    error: "text-danger",
    working: "text-[var(--mt-state-working)]",
    done: "text-success",
    idle: "text-muted",
};

function paletteShortcut(): string {
    return formatShortcutById("palette");
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
        return TabActivity.getInstance().every(whileShown(1000), () => setNow(Date.now()), "clock");
    }, [active]);
    return now;
}

function Dot({ tone, className }: { tone: CardTone; className?: string }) {
    return (
        <span
            className={cn(
                "inline-block h-2 w-2 shrink-0 rounded-full",
                ToneDot[tone],
                tone === "running" && "mt-step-blink",
                className
            )}
            aria-hidden
        />
    );
}

function StatusLine({ line, testId }: { line: NowLine; testId: string }) {
    return (
        <div className="flex min-w-0 items-center gap-2.5 text-13" title={line.title} data-testid={testId}>
            <Dot tone={line.tone} />
            <span className="min-w-0 flex-1 truncate text-primary">{line.label}</span>
            {line.text ? (
                <span className={cn("shrink-0 text-12 tabular-nums", ToneText[line.tone])}>{line.text}</span>
            ) : null}
        </div>
    );
}

function SubHeading({ children }: { children: React.ReactNode }) {
    return <span className="text-12 text-muted">{children}</span>;
}

export function NextReleaseCard({ snapshot }: ProjectCardProps) {
    const locale = useLocale();
    const { state } = useReleaseState(snapshot);
    const github = snapshot?.github;
    const view = useMemo(
        () => nextReleaseView(state, snapshot?.git, github?.milestones, github?.state),
        [state, snapshot?.git, github, locale]
    );
    return <NextPublicRelease view={view} />;
}

export function ReleasesCard({ snapshot }: ProjectCardProps) {
    const locale = useLocale();
    const { tree, state } = useReleaseState(snapshot);
    const view = useMemo(() => releasesView(state, tree?.tagPrefix), [state, tree?.tagPrefix, locale]);
    return <ReleaseHistory view={view} />;
}

function AgentLine({ info, dir }: { info: AgentStateInfo; dir: string }) {
    const t = useT();
    useLocale();
    useWorkingBeat(info.state === "working");
    const [block] = useWaveObjectValue<Block>(makeORef("block", info.blockid));
    const meta = block?.meta;
    const folder = blockFolder({ view: meta?.view, connection: meta?.connection, "cmd:cwd": meta?.["cmd:cwd"] });
    const paneState = usePaneStatus(folder, null);
    // What the agent works on comes before its folder's git state (#1123): a merge queue's agent sits on a detached
    // commit that says nothing of the PRs it rebases.
    const batchOrigin = batchOriginOf(meta);
    const batchRun = useBatchRun(batchOrigin ? dir : null, batchOrigin?.base);
    const work = agentWorkText(meta, batchRun?.blockid === info.blockid ? batchRun : null);
    const branch = !work && folder ? makePaneView(folder, paneState, null).branch : "";
    const goTo = () =>
        fireAndForget(() =>
            MoltentermNotifications.getInstance().goTo({
                workspaceid: info.workspaceid,
                tabid: info.tabid,
                blockid: info.blockid,
            })
        );
    return (
        <div className="flex min-w-0 flex-col">
            <button
                type="button"
                onClick={goTo}
                title={[agentStateTitle(info), work, t("project.agents.goToPane")].filter((s) => !!s).join("\n")}
                className="-mx-1 flex min-w-0 cursor-pointer flex-col rounded-6 px-1 py-0.5 text-left text-13 hover:bg-hover"
                data-testid="project-agent"
            >
                <span className="flex min-w-0 items-center gap-2.5">
                    <span
                        className={cn(
                            "inline-block h-2 w-2 shrink-0 rounded-full",
                            AgentStateDotClasses[info.state] ?? AgentStateDotClasses.idle,
                            info.state === "working" && "mt-beat-turn"
                        )}
                        aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate text-primary">{agentLabel(info)}</span>
                    <span
                        className={cn(
                            "max-w-[55%] shrink-0 truncate text-12",
                            AgentStateText[info.state] ?? "text-muted"
                        )}
                    >
                        {agentStateLabel(info.state)}
                        {branch ? <span className="text-muted"> · {branch}</span> : null}
                    </span>
                </span>
                {work ? (
                    // The work gets its own line: it is what the developer reads the line for (#1123).
                    <span
                        className="min-w-0 truncate pl-[18px] text-12 text-secondary"
                        data-testid="project-agent-work"
                    >
                        {work}
                    </span>
                ) : null}
            </button>
            <AgentSubagents info={info} onGoTo={goTo} />
        </div>
    );
}

// The agent's running sub-agents, as its companion lists them (#967, FR-MC-024): name, ticket, branch and state.
function AgentSubagents({ info, onGoTo }: { info: AgentStateInfo; onGoTo: () => void }) {
    const t = useT();
    useLocale();
    const view = useCompanionFollow(info.blockid);
    const [expanded, setExpanded] = useState(false);
    const subs = nowSubagents(view, info, expanded);
    if (subs.rows.length === 0) {
        return null;
    }
    return (
        <ul
            className="ml-[5px] flex min-w-0 flex-col border-l border-border pl-3"
            aria-label={t("project.agents.subagents", { name: agentCallName(info) })}
            data-testid="project-subagents"
        >
            {subs.rows.map((row) => (
                <li key={row.id} className="min-w-0">
                    <button
                        type="button"
                        onClick={onGoTo}
                        title={[row.name, row.configTitle, t("project.agents.goToPane")].filter((s) => !!s).join("\n")}
                        className="-mx-1 flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-6 px-1 py-0.5 text-left text-12 hover:bg-hover"
                        data-testid="project-subagent"
                    >
                        <span
                            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mt-state-working)]"
                            aria-hidden
                        />
                        <span className="min-w-0 flex-1 truncate text-primary">{row.name}</span>
                        <span className="max-w-[55%] shrink-0 truncate text-[var(--mt-state-working)]">
                            {row.stateLabel}
                            {row.ticket ? <span className="text-muted"> · {row.ticket}</span> : null}
                            {row.branch ? <span className="text-muted"> · {row.branch}</span> : null}
                        </span>
                    </button>
                </li>
            ))}
            {subs.hidden > 0 || (expanded && subs.rows.length > MaxSubagentsShown) ? (
                <li>
                    <button
                        type="button"
                        onClick={() => setExpanded(!expanded)}
                        className="cursor-pointer pt-0.5 text-11 text-muted hover:text-primary"
                        data-testid="project-subagents-more"
                    >
                        {expanded ? t("project.agents.subagentsLess") : subs.moreLabel}
                    </button>
                </li>
            ) : null}
        </ul>
    );
}

function Agents({ workspaceId, dir }: { workspaceId: string; dir: string }) {
    const t = useT();
    const data = useAtomValue(AgentStates.getInstance().dataAtom);
    const agents = useMemo(() => workspaceAgents(data.states, workspaceId), [data, workspaceId]);
    if (agents.length === 0) {
        return <p className="text-12 text-muted">{t("project.agents.none", { keys: paletteShortcut() })}</p>;
    }
    return (
        <div className="flex flex-col" data-testid="project-agents">
            {agents.slice(0, MaxAgentsShown).map((info) => (
                <AgentLine key={info.blockid} info={info} dir={dir} />
            ))}
            {agents.length > MaxAgentsShown ? (
                <span className="pt-0.5 text-11 text-muted">
                    {t("project.agents.more", { count: agents.length - MaxAgentsShown })}
                </span>
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
    const t = useT();
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
                    <div key={item.id} className="flex min-w-0 items-center gap-2.5 text-13" data-testid="project-work">
                        <Dot tone="running" />
                        <span className="min-w-0 flex-1 truncate text-primary">
                            {item.label}
                            {item.detail ? <span className="text-muted"> · {item.detail}</span> : null}
                        </span>
                        <span className="shrink-0 text-12 text-[var(--mt-state-working)] tabular-nums">
                            {clockElapsed(now - item.startedat)}
                        </span>
                    </div>
                ))}
            </div>
            {showRelease ? (
                <ReleaseRunSection
                    dir={project.dir}
                    repo={snapshot?.github?.repo}
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
                <SubHeading>{t("project.agents.heading")}</SubHeading>
                <Agents workspaceId={project.workspace?.oid} dir={project.dir} />
            </div>
        </div>
    );
}

export function StepsCard({ project, projectName, pipeline, runs }: ProjectCardProps) {
    const t = useT();
    const declared = (pipeline?.steps ?? []).some((s) => s.section === OverviewSection);
    if (!declared) {
        return (
            <p className="text-12 text-muted">
                {pipeline ? t("project.steps.none", { section: OverviewSection }) : t("project.steps.noPipeline")}
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
