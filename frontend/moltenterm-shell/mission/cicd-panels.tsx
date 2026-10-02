// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The tabs of the CI/CD panel (FR-MC-002). CI remote is ported from Notulia's Dev › CI (GithubPanels.tsx): open pull
// requests with their checks, scheduled workflows with their next runs, recent runs. CD lists what was released.
// CI local shows the pipeline's state until local runs are wired (FR-MC-005).

import { openLink } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useMemo } from "react";
import { formatWhen, timeAgo } from "./branch-tree";
import {
    CheckState,
    describeCron,
    eventLabel,
    mergeStateLabel,
    nextRuns,
    prSummary,
    runState,
    scheduledWorkflows,
    summarizeChecks,
    WorkflowRun,
} from "./github";
import { githubStateMessage, MissionGit, MissionGithub } from "./mission-model";
import { isPrereleaseTag } from "./tree";

const ToneClasses: Record<CheckState, string> = {
    success: "border-success/40 bg-success/10 text-success",
    failure: "border-error/40 bg-error/10 text-error",
    pending: "border-warning/40 bg-warning/10 text-warning",
    neutral: "border-border bg-hover text-muted",
};

const ToneIcons: Record<CheckState, string> = {
    success: "fa-circle-check text-success",
    failure: "fa-circle-xmark text-error",
    pending: "fa-circle-notch fa-spin text-warning",
    neutral: "fa-circle-minus text-muted",
};

export function CheckIcon({ state }: { state: CheckState }) {
    return <i className={cn("fa fa-solid text-[11px]", ToneIcons[state])} />;
}

function open(url: string) {
    fireAndForget(() => openLink(url));
}

export function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) {
        return `${seconds} s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes} min ${String(seconds % 60).padStart(2, "0")}`;
    }
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

function localTime(d: Date): string {
    return d.toLocaleString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function BlockHeader({ title, hint }: { title: string; hint?: string }) {
    return (
        <h2 className="text-sm font-semibold">
            {title}
            {hint ? <span className="ml-2 text-xs font-normal text-muted">{hint}</span> : null}
        </h2>
    );
}

export function Problem({ text }: { text: string }) {
    return <div className="rounded border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">{text}</div>;
}

export function Notice({ text }: { text: string }) {
    return <div className="rounded border border-border bg-hover px-3 py-2 text-xs text-secondary">{text}</div>;
}

function Placeholder({ rows }: { rows: number }) {
    return (
        <div className="flex flex-col gap-3 p-3" aria-busy="true">
            {Array.from({ length: rows }, (_, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                    <div className="h-4 w-3/4 animate-pulse rounded bg-hover" />
                    <div className="h-3 w-1/2 animate-pulse rounded bg-hover" />
                </div>
            ))}
        </div>
    );
}

function PullRequestsBlock({ github, trunk }: { github: MissionGithub; trunk: string }) {
    const prs = github?.prs;
    return (
        <section className="flex flex-col gap-2">
            <BlockHeader title="Pull requests waiting" hint="hover: what it brings · merging happens on GitHub" />
            {github?.errors?.prs ? <Problem text={github.errors.prs} /> : null}
            <div className="overflow-hidden rounded border border-border">
                {github == null ? <Placeholder rows={3} /> : null}
                {github != null && (prs ?? []).length === 0 && !github.errors?.prs ? (
                    <p className="p-3 text-sm text-muted">No open pull request.</p>
                ) : null}
                {(prs ?? []).map((pr) => {
                    const merge = mergeStateLabel(pr.isDraft ? "DRAFT" : pr.mergeStateStatus, pr.baseRefName || trunk);
                    const checks = summarizeChecks(pr.statusCheckRollup);
                    return (
                        <div
                            key={pr.number}
                            title={prSummary(pr.body) ?? undefined}
                            className="flex flex-col gap-2 border-b border-border px-3 py-2.5 last:border-b-0 hover:bg-hover"
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-medium">
                                        <span className="text-muted">#{pr.number}</span> {pr.title}
                                    </div>
                                    <div className="truncate text-xs text-muted">
                                        <code>{pr.headRefName}</code> → <code>{pr.baseRefName}</code> · updated{" "}
                                        {timeAgo(pr.updatedAt)}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => open(pr.url)}
                                    className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded border border-border px-2 py-1 text-xs hover:bg-hover"
                                >
                                    <i className="fa fa-solid fa-arrow-up-right-from-square text-[10px]" />
                                    Open
                                </button>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                                <span className={cn("rounded border px-2 py-0.5 text-xs", ToneClasses[merge.tone])}>
                                    {merge.label}
                                </span>
                                {checks.map((c) => (
                                    <span
                                        key={c.name}
                                        className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs"
                                        title={c.local ? "local check" : "GitHub job"}
                                    >
                                        <CheckIcon state={c.state} />
                                        {c.name}
                                    </span>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

function ScheduledBlock({ github }: { github: MissionGithub }) {
    const schedules = useMemo(() => scheduledWorkflows(github?.workflows ?? []), [github?.workflows]);
    const now = new Date();
    return (
        <section className="flex flex-col gap-2">
            <BlockHeader title="Scheduled jobs" hint="local times · GitHub may start them hours late" />
            <div className="overflow-hidden rounded border border-border">
                {github == null ? <Placeholder rows={2} /> : null}
                {github != null && schedules.length === 0 ? (
                    <p className="p-3 text-sm text-muted">No scheduled workflow.</p>
                ) : null}
                {schedules.map((wf) => {
                    const next = wf.crons
                        .flatMap((c) => nextRuns(c, now, 3))
                        .sort((a, b) => a.getTime() - b.getTime())
                        .slice(0, 3);
                    const last = (github?.runs ?? []).find((r) => r.event === "schedule" && r.workflowName === wf.name);
                    return (
                        <div
                            key={wf.file}
                            className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0"
                        >
                            <div className="flex items-center justify-between gap-2">
                                <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                                    <i className="fa fa-solid fa-calendar-days text-[11px] text-muted" />
                                    <span className="truncate">{wf.name}</span>
                                    <code className="text-[11px] font-normal text-muted">{wf.file}</code>
                                </span>
                                {last ? (
                                    <button
                                        type="button"
                                        onClick={() => open(last.url)}
                                        className="flex shrink-0 cursor-pointer items-center gap-1 text-xs text-muted hover:text-primary"
                                    >
                                        <CheckIcon state={runState(last.status, last.conclusion)} />
                                        last {timeAgo(last.createdAt)}
                                    </button>
                                ) : null}
                            </div>
                            <div className="text-xs text-muted">{wf.crons.map((c) => describeCron(c)).join(" · ")}</div>
                            {next.length > 0 ? (
                                <div className="flex flex-wrap gap-1.5">
                                    {next.map((d) => (
                                        <span
                                            key={d.toISOString()}
                                            className="rounded border border-border px-1.5 py-0.5 text-[11px]"
                                        >
                                            {localTime(d)}
                                        </span>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

function RunRow({ run }: { run: WorkflowRun }) {
    const state = runState(run.status, run.conclusion);
    return (
        <button
            type="button"
            onClick={() => open(run.url)}
            className="grid w-full cursor-pointer grid-cols-[16px_1fr_auto] items-center gap-x-2 gap-y-0.5 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-hover"
        >
            <CheckIcon state={state} />
            <span className="truncate text-sm">
                <span className="font-medium">{run.workflowName}</span>
                <span className="ml-2 rounded border border-border px-1 text-[11px] text-muted">
                    {eventLabel(run.event)}
                </span>
            </span>
            <span className="text-xs text-muted">
                {state === "pending"
                    ? "running"
                    : formatDuration(new Date(run.updatedAt).getTime() - new Date(run.createdAt).getTime())}
            </span>
            <span className="col-start-2 col-end-4 truncate text-xs text-muted">
                <code>{run.headBranch}</code> · {timeAgo(run.createdAt)} · {run.displayTitle}
            </span>
        </button>
    );
}

function RecentRunsBlock({ github }: { github: MissionGithub }) {
    const runs = github?.runs;
    return (
        <section className="flex flex-col gap-2">
            <BlockHeader title="Recent jobs" />
            {github?.errors?.runs ? <Problem text={github.errors.runs} /> : null}
            <div className="overflow-hidden rounded border border-border">
                {github == null ? <Placeholder rows={4} /> : null}
                {github != null && (runs ?? []).length === 0 && !github.errors?.runs ? (
                    <p className="p-3 text-sm text-muted">No recent job.</p>
                ) : null}
                {(runs ?? []).map((run) => (
                    <RunRow key={run.databaseId} run={run} />
                ))}
            </div>
        </section>
    );
}

export function RemoteCiTab({ github, trunk }: { github: MissionGithub; trunk: string }) {
    const stateMessage = githubStateMessage(github);
    if (stateMessage) {
        return <Notice text={stateMessage} />;
    }
    return (
        <div className="flex flex-col gap-5">
            <PullRequestsBlock github={github} trunk={trunk} />
            <div className="grid gap-5 @3xl:grid-cols-2">
                <ScheduledBlock github={github} />
                <RecentRunsBlock github={github} />
            </div>
        </div>
    );
}

type Delivery = { tag: string; date: string; rc: boolean; github?: { draft: boolean; latest: boolean; name: string } };

// What was delivered: the version tags from git, with their GitHub release when there is one.
export function makeDeliveries(git: MissionGit, github: MissionGithub): Delivery[] {
    const releases = new Map((github?.releases ?? []).map((r) => [r.tagName, r]));
    const rows: Delivery[] = (git?.tags ?? []).map((t) => {
        const release = releases.get(t.name);
        releases.delete(t.name);
        return {
            tag: t.name,
            date: t.date,
            rc: isPrereleaseTag(t.name),
            github: release ? { draft: release.isDraft, latest: release.isLatest, name: release.name } : undefined,
        };
    });
    for (const release of releases.values()) {
        rows.push({
            tag: release.tagName,
            date: release.publishedAt || release.createdAt,
            rc: release.isPrerelease || isPrereleaseTag(release.tagName),
            github: { draft: release.isDraft, latest: release.isLatest, name: release.name },
        });
    }
    return rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export function CdTab({ git, github }: { git: MissionGit; github: MissionGithub }) {
    const deliveries = makeDeliveries(git, github);
    const repoUrl = github?.url || git?.remoteurl;
    return (
        <div className="flex flex-col gap-5">
            <section className="flex flex-col gap-2">
                <BlockHeader title="Gold builds" hint="the local build you use every day" />
                <Notice text="No gold build yet: they appear here once the project's pipeline declares a local build." />
            </section>
            <section className="flex flex-col gap-2">
                <BlockHeader title="Releases and release candidates" hint="from the project's version tags" />
                {githubStateMessage(github) ? <Notice text={githubStateMessage(github)} /> : null}
                <div className="overflow-hidden rounded border border-border">
                    {deliveries.length === 0 ? <p className="p-3 text-sm text-muted">No version tagged yet.</p> : null}
                    {deliveries.map((d) => (
                        <button
                            key={d.tag}
                            type="button"
                            disabled={!repoUrl}
                            onClick={() => open(`${repoUrl}/releases/tag/${encodeURIComponent(d.tag)}`)}
                            className="flex w-full cursor-pointer items-center gap-2 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-hover"
                        >
                            <i
                                className={cn(
                                    "fa fa-solid text-[11px]",
                                    d.rc ? "fa-flag text-warning" : "fa-box text-accent"
                                )}
                            />
                            <span className="font-mono text-sm font-medium">{d.tag}</span>
                            <span className="rounded border border-border px-1 text-[11px] text-muted">
                                {d.rc ? "release candidate" : "public"}
                            </span>
                            {d.github?.latest ? (
                                <span className="rounded bg-accent/20 px-1 text-[11px] text-accent">latest</span>
                            ) : null}
                            {d.github?.draft ? (
                                <span className="rounded bg-warning/20 px-1 text-[11px] text-warning">draft</span>
                            ) : null}
                            {!d.github && github?.state === "ok" ? (
                                <span className="text-[11px] text-muted">tag only</span>
                            ) : null}
                            <span className="ml-auto text-xs text-muted" title={formatWhen(d.date)}>
                                {timeAgo(d.date)}
                            </span>
                        </button>
                    ))}
                </div>
            </section>
        </div>
    );
}
