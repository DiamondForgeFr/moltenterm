// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Project tab's own cards (FR-SHELL-015), composed from Mission Control's panels: the status band (agents,
// releases, work in progress), the living branches with their local CI verdict and pull request, and the actions,
// each showing its plan before it runs (Build local, Release, Clean branches). They register like any contribution.

import { openLink } from "@/app/store/global";
import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { isMacOS } from "@/util/platformutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { AgentStateDotClasses, AgentStateInfo, agentStateLabel, agentStateTitle } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { BranchCleanupButton } from "../mission/branch-cleanup";
import { timeAgo } from "../mission/branch-tree";
import { BuildLocalMenu } from "../mission/build-local-menu";
import { CheckIcon } from "../mission/cicd-panels";
import { formatElapsed, latestRun, RunStateLabels, toTreeData } from "../mission/mission-model";
import { ReleaseMenu } from "../mission/release-menu";
import { ReleaseRunSection } from "../mission/release-run-panel";
import { daysSince } from "../mission/release-state-panel";
import { BuildRunCard } from "../mission/runs-view";
import { useDeliveredManifest } from "../mission/timeline-view";
import { releaseState, tagVersion, treeRules } from "../mission/versions";
import { MoltentermNotifications } from "../notifications-store";
import { usePaneStatus } from "../pane-status";
import { blockFolder, ciVerdictView, makePaneView } from "../status-bar-model";
import { ProjectCard } from "./project-cards";
import { ProjectCardProps } from "./project-context";
import {
    BranchRow,
    BranchRowsShown,
    checkWebUrl,
    projectBranchRows,
    projectWork,
    workspaceAgents,
} from "./project-model";

const MaxAgentsShown = 5;

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

function AgentsCard({ project }: ProjectCardProps) {
    const data = useAtomValue(AgentStates.getInstance().dataAtom);
    const workspaceId = project.workspace?.oid;
    const agents = useMemo(() => workspaceAgents(data.states, workspaceId), [data, workspaceId]);
    if (agents.length === 0) {
        return (
            <p className="text-xs text-muted">
                No coding agent in this workspace. Start one from the palette ({paletteShortcut()}).
            </p>
        );
    }
    return (
        <div className="-mx-1 flex flex-col">
            {agents.slice(0, MaxAgentsShown).map((info) => (
                <AgentLine key={info.blockid} info={info} />
            ))}
            {agents.length > MaxAgentsShown ? (
                <span className="px-1 pt-0.5 text-[11px] text-muted">and {agents.length - MaxAgentsShown} more</span>
            ) : null}
        </div>
    );
}

function ReleasesCard({ snapshot }: ProjectCardProps) {
    const git = snapshot?.git;
    const tree = useMemo(() => (git ? toTreeData(git) : null), [git]);
    const state = useMemo(
        () => (tree ? releaseState(tree.tags, git.ahead ?? [], git.sincepublic ?? [], treeRules(tree)) : null),
        [tree, git]
    );
    if (state == null) {
        return <div className="h-12 animate-pulse rounded bg-hover/40" aria-busy="true" />;
    }
    const prefix = tree.tagPrefix;
    const { lastPublic, lastRc, next } = state;
    // A candidate older than the last public release was released already: there is no candidate in flight.
    const candidate =
        lastRc && (!lastPublic || new Date(lastRc.date).getTime() >= new Date(lastPublic.date).getTime())
            ? lastRc
            : null;
    return (
        <div className="flex flex-col" data-testid="project-releases">
            <Line label="Public">
                {lastPublic ? (
                    <>
                        <span className="font-medium text-primary">{lastPublic.name}</span>
                        <span className="text-muted">{daysSince(lastPublic.date)}</span>
                    </>
                ) : (
                    <span className="text-muted">none yet</span>
                )}
            </Line>
            <Line label="Candidate">
                {candidate ? (
                    <>
                        <span className="font-medium text-primary">{candidate.name}</span>
                        <span className="text-muted">{daysSince(candidate.date)}</span>
                    </>
                ) : (
                    <span className="text-muted">
                        {lastRc ? `none since ${tagVersion(lastPublic.name, prefix)}` : "none yet"}
                    </span>
                )}
            </Line>
            <Line label="Next" title={next.reason}>
                <span className={cn("font-medium", next.version ? "text-primary" : "text-muted")}>
                    {next.version ? `${prefix}${next.version}` : "nothing to release"}
                </span>
                {next.how === "decision" ? <span className="text-warning">to decide</span> : null}
                {git.release !== git.trunk && state.pending.total > 0 ? (
                    <span className="truncate text-muted">
                        {state.pending.total} change{state.pending.total === 1 ? "" : "s"} on {git.trunk}
                    </span>
                ) : null}
            </Line>
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

function WorkCard({ ci, runs, release, snapshot }: ProjectCardProps) {
    const work = useMemo(() => projectWork(ci, runs, release), [ci, runs, release]);
    const now = useNow(work.length > 0);
    const trunk = snapshot?.git?.trunk;
    const trunkVerdict = ciVerdictView((ci?.branches ?? []).find((b) => b.name === trunk)?.verdict);
    const lastBuild = latestRun(runs, "build");
    return (
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
            {work.length === 0 ? <p className="py-0.5 text-xs text-muted">Nothing running.</p> : null}
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
            {lastBuild && lastBuild.state !== "running" ? (
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
    );
}

const RoleLabels: Record<BranchRow["role"], string> = { trunk: "trunk", release: "release", feature: "" };

function BranchCi({ row }: { row: BranchRow }) {
    const view = ciVerdictView(row.ci);
    if (view == null) {
        return <span className="text-muted">—</span>;
    }
    return (
        <span className="flex items-center gap-1.5" title={view.label}>
            <i className={cn("fa fa-solid text-[11px]", view.iconClass)} />
            <span className="text-secondary">{view.label.replace(/^CI /, "")}</span>
        </span>
    );
}

function BranchPrCell({ row }: { row: BranchRow }) {
    const pr = row.pr;
    if (pr == null) {
        return <span className="text-muted">no pull request</span>;
    }
    const tone =
        pr.merge.tone === "success"
            ? "text-success"
            : pr.merge.tone === "failure"
              ? "text-error"
              : pr.merge.tone === "pending"
                ? "text-warning"
                : "text-muted";
    return (
        <span className="flex min-w-0 items-center gap-1.5">
            <button
                type="button"
                onClick={() => {
                    if (checkWebUrl(pr.url)) {
                        fireAndForget(() => openLink(pr.url));
                    }
                }}
                title={`#${pr.number} ${pr.title}`}
                className="shrink-0 cursor-pointer text-primary hover:underline"
            >
                #{pr.number}
            </button>
            <span className={cn("min-w-0 truncate", tone)}>{pr.merge.label}</span>
            {pr.checks.failed > 0 ? (
                <span className="flex shrink-0 items-center gap-0.5" title={`${pr.checks.failed} check(s) failing`}>
                    <CheckIcon state="failure" />
                    {pr.checks.failed}
                </span>
            ) : null}
            {pr.checks.pending > 0 ? (
                <span className="flex shrink-0 items-center gap-0.5" title={`${pr.checks.pending} check(s) running`}>
                    <CheckIcon state="pending" />
                    {pr.checks.pending}
                </span>
            ) : null}
            {pr.checks.passed > 0 && pr.checks.failed === 0 ? (
                <span className="flex shrink-0 items-center gap-0.5" title={`${pr.checks.passed} check(s) passed`}>
                    <CheckIcon state="success" />
                    {pr.checks.passed}
                </span>
            ) : null}
        </span>
    );
}

function BranchLine({ row, busy, onRunCi }: { row: BranchRow; busy: boolean; onRunCi: () => void }) {
    return (
        <div
            className="group grid grid-cols-[minmax(0,1.3fr)_7rem_minmax(0,1.4fr)_4.5rem_auto] items-center gap-3 border-b border-border px-3 py-1.5 text-xs last:border-b-0 hover:bg-hover/50"
            data-testid="project-branch"
            data-branch={row.name}
        >
            <span className="flex min-w-0 items-center gap-1.5">
                <i
                    className={cn(
                        "fa fa-solid w-3 shrink-0 text-[10px]",
                        row.role === "feature" ? "fa-code-branch text-muted" : "fa-code-commit text-accent"
                    )}
                />
                <span className={cn("truncate", row.current ? "font-semibold text-primary" : "text-primary")}>
                    {row.name}
                </span>
                {RoleLabels[row.role] ? (
                    <span className="shrink-0 rounded bg-hover px-1 text-[10px] text-muted">
                        {RoleLabels[row.role]}
                    </span>
                ) : null}
                {row.current ? (
                    <span className="shrink-0 text-[10px] text-muted" title="Checked out in the project's folder">
                        HEAD
                    </span>
                ) : null}
                {row.ahead ? (
                    <span
                        className="shrink-0 text-muted tabular-nums"
                        title={`${row.ahead} commit(s) not on the trunk yet`}
                    >
                        ↑{row.ahead}
                    </span>
                ) : null}
            </span>
            <BranchCi row={row} />
            <BranchPrCell row={row} />
            <span className="text-right text-muted tabular-nums">{timeAgo(row.date)}</span>
            <button
                type="button"
                disabled={busy}
                onClick={onRunCi}
                title={`Run the local CI on ${row.name}: only what is not green yet runs`}
                className="cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-muted opacity-60 transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-30"
            >
                Run CI
            </button>
        </div>
    );
}

function BranchesCard({ snapshot, ci, runCi }: ProjectCardProps) {
    const [all, setAll] = useState(false);
    const git = snapshot?.git;
    const { rows, merged } = useMemo(
        () => projectBranchRows(git, ci?.branches, snapshot?.github?.prs, ci?.current),
        [git, ci?.branches, snapshot?.github?.prs, ci?.current]
    );
    if (git == null) {
        return (
            <div className="flex flex-col gap-1.5 p-3" aria-busy="true">
                {[0, 1, 2].map((i) => (
                    <div key={i} className="h-5 animate-pulse rounded bg-hover/40" />
                ))}
            </div>
        );
    }
    const shown = all ? rows : rows.slice(0, BranchRowsShown);
    const running = !!ci?.running;
    return (
        <div className="flex flex-col" data-testid="project-branches">
            {shown.map((row) => (
                <BranchLine key={row.name} row={row} busy={running} onRunCi={() => runCi(row.name)} />
            ))}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[11px] text-muted">
                {rows.length > BranchRowsShown ? (
                    <button
                        type="button"
                        onClick={() => setAll(!all)}
                        className="cursor-pointer text-secondary hover:text-primary"
                    >
                        {all ? "Show fewer" : `Show all ${rows.length} branches`}
                    </button>
                ) : null}
                {merged > 0 ? (
                    <span>
                        {merged} other branch{merged === 1 ? " has" : "es have"} nothing left to merge into {git.trunk}:
                        Clean branches shows what would go.
                    </span>
                ) : null}
                {snapshot?.github?.state && snapshot.github.state !== "ok" ? (
                    <span>Pull requests unknown: {snapshot.github.message || snapshot.github.state}.</span>
                ) : null}
            </div>
        </div>
    );
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
        <div className="flex flex-col gap-2 p-3" data-testid="project-actions">
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

function RunsCard({ project, projectName, pipeline, runs, release, reloadRelease, startBuild }: ProjectCardProps) {
    const lastBuild = latestRun(runs, "build");
    const delivered = useDeliveredManifest(project.dir, lastBuild);
    const buildDef = (pipeline?.builds ?? []).find((b) => b.id === lastBuild?.stepid);
    const showBuild = lastBuild != null && !lastBuild.closed;
    if (!showBuild && pipeline == null) {
        return null;
    }
    return (
        <div className="flex flex-col gap-3" data-testid="project-runs">
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
        </div>
    );
}

// Band cards show without a frame (the band is one strip); the others get the core's frame with their title.
export const BuiltinProjectCards: ProjectCard<ProjectCardProps>[] = [
    { id: "moltenterm:agents", title: "Agents", region: "band", order: 10, component: AgentsCard },
    { id: "moltenterm:releases", title: "Releases", region: "band", order: 20, component: ReleasesCard },
    { id: "moltenterm:work", title: "In progress", region: "band", order: 30, component: WorkCard },
    { id: "moltenterm:branches", title: "Branches", region: "main", order: 10, component: BranchesCard },
    { id: "moltenterm:actions", title: "Actions", region: "side", order: 10, component: ActionsCard },
    { id: "moltenterm:runs", title: "Runs", region: "side", order: 20, bare: true, component: RunsCard },
];
