// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The row of four cards under the line map (FR-MC-024, DS-MC-012), each the only home of its summary: Next public
// release (what waits on the trunk, by kind, and the milestone), Releases (the last release candidate and the last
// public release), Now (the CI on the trunk, the last local build, the last release, the agents: one flat line for each,
// what runs being in the "In progress" band above, #2188) and Project steps (the pipeline's overview steps, FR-MC-018).
// They are contributions like a mod's card (project-builtin-cards.tsx).

import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useMemo, useState } from "react";
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
import { deliveredBy } from "../mission/builds-model";
import { latestRun, MissionSnapshot, toTreeData } from "../mission/mission-model";
import { openSetupTab } from "../mission/pipeline-tab-open";
import { NextPublicRelease, ReleaseHistory } from "../mission/release-state-panel";
import { showBuildInFolder, useDeliveredManifest } from "../mission/runs-view";
import { releaseState, treeRules } from "../mission/versions";
import { MoltentermNotifications } from "../notifications-store";
import { usePaneStatus } from "../pane-status";
import { useBatchRun } from "../reviews/reviews-batch-client";
import { formatShortcutById } from "../shortcuts/format";
import { blockFolder, makePaneView } from "../status-bar-model";
import { DominoLoader } from "../suite/suite";
import { useWorkingBeat } from "../working-beat";
import {
    buildNowLine,
    CardTone,
    hasOverviewSteps,
    MaxSubagentsShown,
    nextReleaseView,
    NowLine,
    nowSubagents,
    OverviewSection,
    releaseNowLine,
    releasesView,
    trunkCiLine,
} from "./overview-cards-model";
import { ProjectCardProps } from "./project-context";
import { workspaceAgents } from "./project-model";
import { buildInBand } from "./running-band-model";
import { useNow } from "./use-now";

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

// What runs shows the dominoes at icon size (DS-SHELL-154); the other tones keep their dot.
function Dot({ tone, className }: { tone: CardTone; className?: string }) {
    if (tone === "running") {
        return <DominoLoader className={cn("mt-dominos-icon text-[var(--mt-state-working)]", className)} />;
    }
    return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", ToneDot[tone], className)} aria-hidden />;
}

const LineActionClass =
    "shrink-0 cursor-pointer text-12 text-accent underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-50";

// One flat line of the Now card: a mark, what it is, how it stands, and the action that follows from it (Rebuild).
function StatusLine({ line, testId, actions }: { line: NowLine; testId: string; actions?: React.ReactNode }) {
    return (
        <div className="flex min-w-0 items-center gap-2.5 text-13" title={line.title} data-testid={testId}>
            <Dot tone={line.tone} />
            <span className="min-w-0 flex-1 truncate text-primary">{line.label}</span>
            {line.text ? (
                <span className={cn("shrink-0 text-12 tabular-nums", ToneText[line.tone])}>{line.text}</span>
            ) : null}
            {actions}
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

// What happens now, one flat line for each thing (#2188): the CI on the trunk, the last local build, the last release,
// then the workspace's agents. What runs is a row of the band above, and its line here says "running, see above".
export function NowCard({ project, pipeline, runs, ci, startBuild, snapshot, releaseFollow }: ProjectCardProps) {
    const t = useT();
    useLocale();
    const trunk = snapshot?.git?.trunk;
    const { state } = useReleaseState(snapshot);
    const lastBuild = latestRun(runs, "build");
    const delivered = useDeliveredManifest(project.dir, lastBuild);
    const now = useNow(!!ci?.running);
    const ciLine = trunkCiLine(ci, trunk, now);
    const inBand = buildInBand(lastBuild);
    const buildLine = buildNowLine(lastBuild, inBand, now);
    const followed = releaseFollow?.run ?? null;
    const releaseLine = releaseNowLine(
        state,
        followed && {
            tag: followed.tag,
            failed: followed.phases.some((p) => p.status === "failed"),
        },
        now
    );
    const rebuildable = lastBuild != null && !inBand && (pipeline?.builds ?? []).some((b) => b.id === lastBuild.stepid);
    const folder = lastBuild != null && !!lastBuild.artifact && deliveredBy(lastBuild, delivered) != null;
    return (
        <div className="flex flex-col gap-3" data-testid="project-now">
            <div className="flex flex-col gap-2">
                {ciLine ? <StatusLine line={ciLine} testId="project-now-ci" /> : null}
                <StatusLine
                    line={buildLine}
                    testId="project-now-build"
                    actions={
                        <>
                            {folder ? (
                                <button
                                    type="button"
                                    onClick={() => showBuildInFolder(lastBuild)}
                                    className={LineActionClass}
                                    data-testid="project-now-build-folder"
                                >
                                    {t("mc.builds.showInFolder")}
                                </button>
                            ) : null}
                            {rebuildable ? (
                                <button
                                    type="button"
                                    onClick={() => fireAndForget(() => startBuild(lastBuild.stepid))}
                                    className={LineActionClass}
                                    data-testid="project-now-build-rebuild"
                                >
                                    {t("project.now.rebuild")}
                                </button>
                            ) : null}
                        </>
                    }
                />
                {releaseLine ? <StatusLine line={releaseLine} testId="project-now-release" /> : null}
            </div>
            <div className="h-px bg-border" />
            <div className="flex flex-col gap-1.5">
                <SubHeading>{t("project.agents.heading")}</SubHeading>
                <Agents workspaceId={project.workspace?.oid} dir={project.dir} />
            </div>
        </div>
    );
}

export function StepsCard({ project, projectName, pipeline, runs }: ProjectCardProps) {
    if (!hasOverviewSteps(pipeline)) {
        return null;
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

// Where the Project steps card was: when the pipeline declares no overview step, the card gives its cell to the others
// and leaves this one discreet line under the row (#2188). It goes by itself once there are steps.
export function StepsHint({ project, projectName, pipeline }: ProjectCardProps) {
    const t = useT();
    const [error, setError] = useState<string>(null);
    if (hasOverviewSteps(pipeline)) {
        return null;
    }
    if (!pipeline) {
        return (
            <p className="px-1 text-12 text-muted" data-testid="project-steps-hint">
                {t("project.steps.noPipeline")}
            </p>
        );
    }
    return (
        <p className="flex flex-wrap items-baseline gap-x-2 px-1 text-12 text-muted" data-testid="project-steps-hint">
            <span>{t("project.steps.none", { section: OverviewSection })}</span>
            <button
                type="button"
                onClick={() => {
                    setError(null);
                    openSetupTab(project.dir, projectName, undefined, setError);
                }}
                className="cursor-pointer text-accent underline-offset-2 hover:underline"
                data-testid="project-steps-add"
            >
                {t("project.steps.add")}
            </button>
            <span>{t("project.steps.comesBack")}</span>
            {error ? <span className="text-danger">{error}</span> : null}
        </p>
    );
}
