// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The tabs of the CI/CD workshop (FR-MC-025, formerly FR-MC-002). CI remote is ported from Notulia's Dev › CI
// (GithubPanels.tsx): open pull requests with their checks, scheduled workflows with their next runs, recent runs. CD
// holds the local builds with their logs and the full tag registry. Summaries and actions live in Project (DS-MC-012).

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useMemo, useRef, useState } from "react";
import { TFunction, useT, useTCount } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { openWebLink } from "../open-web-link";
import { ReviewsModel } from "../reviews/reviews-store";
import { whileShown } from "../tab-activity";
import { everyInPanel, usePanelBlockId } from "../view360/offcarpet-model";
import {
    BranchCiAnswer,
    BranchCiJob,
    BranchCiRun,
    jobElapsedMs,
    runElapsedMs,
    useBranchCi,
    waitingReviewCount,
} from "./branch-ci";
import { checkIconState, CiIcon, CiIconLabels, githubRunIconState } from "./ci-icon";
import { ActionRowClass, RerunConfirm, RowAction, RowActions } from "./ci-row-actions";
import {
    CheckState,
    describeCron,
    eventLabel,
    githubOnlySchedules,
    nextRuns,
    runState,
    scheduledWorkflows,
    WorkflowRun,
} from "./github";
import { githubRunLog, githubRunRerun } from "./mission-client";
import { labelRecord } from "./mission-i18n";
import { githubStateMessage, MissionGit, MissionGithub, PipelineReport, RunRecord } from "./mission-model";
import { RecentBuilds } from "./runs-view";
import { RegistryKind, RegistryRow, tagRegistry } from "./tag-registry";
import { dateLocale, formatWhen, timeAgo } from "./time-format";

const ClockTickMs = 1000;

export function CheckIcon({ state }: { state: CheckState }) {
    return <CiIcon state={checkIconState(state)} />;
}

function open(url: string) {
    fireAndForget(() => openWebLink(url));
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
    return d.toLocaleString(dateLocale(), {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });
}

export function BlockHeader({ title, hint }: { title: string; hint?: string }) {
    return (
        <h2 className="text-13 leading-5 font-semibold">
            {title}
            {hint ? <span className="ml-2 text-12 font-normal text-muted">{hint}</span> : null}
        </h2>
    );
}

export function Problem({ text }: { text: string }) {
    return <div className="rounded-4 border border-error/40 bg-error/10 px-3 py-2 text-12 text-danger">{text}</div>;
}

export function Notice({ text }: { text: string }) {
    return <div className="rounded-4 border border-border bg-hover px-3 py-2 text-12 text-secondary">{text}</div>;
}

function Placeholder({ rows }: { rows: number }) {
    return (
        <div className="flex flex-col gap-3 p-3" aria-busy="true">
            {Array.from({ length: rows }, (_, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                    <div className="h-4 w-3/4 mt-step-blink rounded-4 bg-hover" />
                    <div className="h-3 w-1/2 mt-step-blink rounded-4 bg-hover" />
                </div>
            ))}
        </div>
    );
}

export function ScheduledBlock({ github }: { github: MissionGithub }) {
    const t = useT();
    const schedules = useMemo(() => scheduledWorkflows(github?.workflows ?? []), [github?.workflows]);
    const remoteOnly = useMemo(
        () => githubOnlySchedules(github?.runs ?? [], github?.workflows ?? []),
        [github?.runs, github?.workflows]
    );
    const now = new Date();
    return (
        <section className="flex flex-col gap-2">
            <BlockHeader title={t("mc.remote.scheduledTitle")} hint={t("mc.remote.scheduledHint")} />
            <div className="overflow-hidden rounded-4 border border-border">
                {github == null ? <Placeholder rows={2} /> : null}
                {github != null && schedules.length === 0 && remoteOnly.length === 0 ? (
                    <p className="p-3 text-13 leading-5 text-muted">{t("mc.remote.noScheduled")}</p>
                ) : null}
                {remoteOnly.map((last) => (
                    <div
                        key={`github:${last.workflowName}`}
                        className="flex flex-col gap-1 border-b border-border px-3 py-2 last:border-b-0"
                        data-testid="ci-scheduled-github-only"
                    >
                        <div className="flex items-center justify-between gap-2">
                            <span className="flex min-w-0 items-center gap-2 text-13 leading-5 font-medium">
                                <i className="fa fa-solid fa-calendar-days text-11 text-muted" />
                                <span className="truncate">{last.workflowName}</span>
                            </span>
                            <button
                                type="button"
                                onClick={() => open(last.url)}
                                className="flex shrink-0 cursor-pointer items-center gap-1 text-12 text-muted hover:text-primary"
                            >
                                <CheckIcon state={runState(last.status, last.conclusion)} />
                                {t("mc.remote.last", { when: timeAgo(last.createdAt) })}
                            </button>
                        </div>
                        <div className="text-12 text-muted">{t("mc.remote.scheduledOnGithub")}</div>
                    </div>
                ))}
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
                                <span className="flex min-w-0 items-center gap-2 text-13 leading-5 font-medium">
                                    <i className="fa fa-solid fa-calendar-days text-11 text-muted" />
                                    <span className="truncate">{wf.name}</span>
                                    <code className="text-11 font-normal text-muted">{wf.file}</code>
                                </span>
                                {last ? (
                                    <button
                                        type="button"
                                        onClick={() => open(last.url)}
                                        className="flex shrink-0 cursor-pointer items-center gap-1 text-12 text-muted hover:text-primary"
                                    >
                                        <CheckIcon state={runState(last.status, last.conclusion)} />
                                        {t("mc.remote.last", { when: timeAgo(last.createdAt) })}
                                    </button>
                                ) : null}
                            </div>
                            <div className="text-12 text-muted">{wf.crons.map((c) => describeCron(c)).join(" · ")}</div>
                            {next.length > 0 ? (
                                <div className="flex flex-wrap gap-1.5">
                                    {next.map((d) => (
                                        <span
                                            key={d.toISOString()}
                                            className="rounded-4 border border-border px-1.5 py-0.5 text-11"
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

type RunLogView = { text: string; error: string; failedonly?: boolean; truncated?: boolean };

export function RunLogBlock({ log }: { log: RunLogView }) {
    const t = useT();
    if (log == null) {
        return <div className="h-16 mt-step-blink rounded-4 bg-hover" aria-busy="true" />;
    }
    if (log.error) {
        return <Problem text={log.error} />;
    }
    return (
        <>
            <div className="pb-1 text-11 text-muted">
                {log.failedonly ? t("mc.remote.failedSteps") : t("mc.remote.wholeLog")}
                {log.truncated ? t("mc.remote.itsEnd") : ""}
            </div>
            <pre
                tabIndex={0}
                aria-label={t("mc.run.log")}
                className="max-h-64 overflow-auto rounded-4 bg-black/50 p-2 font-mono text-11 leading-snug whitespace-pre-wrap text-primary"
            >
                {log.text === "" ? t("mc.run.noOutput") : log.text}
            </pre>
        </>
    );
}

// A GitHub run's row (FR-SHELL-057): its state as a shape, then Logs (read in the row through gh), Rerun (after a
// question; the failed jobs of a red run) and GitHub, on hover and focus.
function RunRow({
    run,
    dir,
    onRefresh,
    timing,
    badge,
    children,
}: {
    run: WorkflowRun;
    dir: string;
    onRefresh: () => void;
    timing?: string;
    badge?: React.ReactNode;
    children?: React.ReactNode;
}) {
    const t = useT();
    const icon = githubRunIconState(run.status, run.conclusion);
    const active = icon === "running" || icon === "queued";
    const failed = icon === "failure";
    const [logOpen, setLogOpen] = useState(false);
    const [log, setLog] = useState<RunLogView>(null);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const rerunRef = useRef<HTMLButtonElement>(null);
    const toggleLog = () => {
        const next = !logOpen;
        setLogOpen(next);
        if (!next || log != null) {
            return;
        }
        fireAndForget(async () => {
            try {
                const read = await githubRunLog(dir, run.databaseId, failed);
                setLog({
                    text: read?.text ?? "",
                    error: null,
                    failedonly: read?.failedonly,
                    truncated: read?.truncated,
                });
            } catch (e) {
                setLog({ text: "", error: serverErrorText(e) });
            }
        });
    };
    const closeConfirm = () => {
        setConfirming(false);
        setError(null);
        rerunRef.current?.focus();
    };
    const rerun = () =>
        fireAndForget(async () => {
            setBusy(true);
            setError(null);
            try {
                await githubRunRerun(dir, run.databaseId, failed);
                setConfirming(false);
                setLog(null);
                setLogOpen(false);
                onRefresh();
            } catch (e) {
                setError(serverErrorText(e));
            } finally {
                setBusy(false);
            }
        });
    return (
        <div className={ActionRowClass} data-testid="ci-remote-row" data-state={icon}>
            <div className="flex items-center gap-2 px-3 py-2">
                <CiIcon state={icon} />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-13 leading-5">
                            <span className="font-medium">{run.workflowName}</span>
                            <span className="ml-2 rounded-4 border border-border px-1 text-11 text-muted">
                                {eventLabel(run.event)}
                            </span>
                        </span>
                        <span className="shrink-0 text-12 text-muted">
                            {timing ?? (active ? CiIconLabels[icon] : finishedRunDuration(t, run))}
                        </span>
                    </div>
                    <div className="truncate text-12 text-muted">
                        <code>{run.headBranch}</code> · {timeAgo(run.createdAt)} · {run.displayTitle}
                    </div>
                    {badge}
                </div>
                <RowActions label={t("mc.remote.runOn", { workflow: run.workflowName, branch: run.headBranch })}>
                    <RowAction
                        icon="fa-solid fa-file-lines"
                        label={logOpen ? t("mc.remote.hideLog") : t("mc.ci.logs")}
                        expanded={logOpen}
                        onClick={toggleLog}
                        testId="ci-row-logs"
                    />
                    <RowAction
                        buttonRef={rerunRef}
                        icon="fa-solid fa-rotate-right"
                        label={
                            active ? t("mc.remote.rerunLater") : failed ? t("mc.remote.rerunFailed") : t("mc.ci.rerun")
                        }
                        disabled={active}
                        onClick={() => setConfirming(true)}
                        testId="ci-row-rerun"
                    />
                    <RowAction
                        icon="fa-brands fa-github"
                        label={t("mc.remote.openOnGithub")}
                        onClick={() => open(run.url)}
                        testId="ci-row-github"
                    />
                </RowActions>
            </div>
            {children}
            {confirming ? (
                <RerunConfirm
                    question={t(failed ? "mc.remote.rerunFailedQuestion" : "mc.remote.rerunQuestion", {
                        workflow: run.workflowName,
                        branch: run.headBranch,
                    })}
                    confirmLabel={failed ? t("mc.remote.rerunFailedShort") : t("mc.ci.rerun")}
                    busy={busy}
                    error={error}
                    onConfirm={rerun}
                    onCancel={closeConfirm}
                />
            ) : null}
            {logOpen ? (
                <div className="px-3 pb-2" data-testid="ci-remote-log">
                    <RunLogBlock log={log} />
                </div>
            ) : null}
        </div>
    );
}

function RecentRunsBlock({ github, dir, onRefresh }: { github: MissionGithub; dir: string; onRefresh: () => void }) {
    const t = useT();
    const runs = github?.runs;
    return (
        <section className="flex flex-col gap-2">
            <BlockHeader title={t("mc.remote.recentTitle")} hint={t("mc.remote.recentHint")} />
            {github?.errors?.runs ? <Problem text={github.errors.runs} /> : null}
            <div className="overflow-hidden rounded-4 border border-border">
                {github == null ? <Placeholder rows={4} /> : null}
                {github != null && (runs ?? []).length === 0 && !github.errors?.runs ? (
                    <p className="p-3 text-13 leading-5 text-muted">{t("mc.remote.noRecent")}</p>
                ) : null}
                {(runs ?? []).map((run) => (
                    <RunRow key={run.databaseId} run={run} dir={dir} onRefresh={onRefresh} />
                ))}
            </div>
        </section>
    );
}

// The pull requests live in Reviews (#836): here only how many wait, and the way there.
export function ReviewsLine({ github, target, dir }: { github: MissionGithub; target: string; dir: string }) {
    const t = useT();
    const tCount = useTCount();
    if (github == null || github.errors?.prs) {
        return null;
    }
    const count = waitingReviewCount(github.prs, target);
    return (
        <button
            type="button"
            onClick={() => fireAndForget(() => ReviewsModel.getInstance().openReviews(dir))}
            className="flex cursor-pointer items-center gap-2 self-start rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
            title={t("mc.remote.toReviewsTitle")}
            data-testid="ci-remote-reviews-line"
            data-count={count}
        >
            <i className="fa fa-solid fa-code-pull-request text-11 text-muted" />
            {count === 0 ? t("mc.remote.noReviewWaiting") : tCount("mc.remote.reviewsWaiting", count, { count })}
            <span className="flex items-center gap-1 text-primary">
                <i className="fa fa-solid fa-arrow-right text-11" />
                {t("mc.remote.toReviews")}
            </span>
        </button>
    );
}

function usualText(ms: number): string {
    if (!ms) {
        return "";
    }
    return ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60000)} min`;
}

// A finished run that took 0 ms, or whose times are missing, has an unknown duration (FR-SHELL-100), never "0 s".
export function finishedRunDuration(t: TFunction, run: WorkflowRun): string {
    const ms = new Date(run.updatedAt).getTime() - new Date(run.createdAt).getTime();
    return Number.isFinite(ms) && ms > 0 ? formatDuration(ms) : t("mc.remote.unknownDuration");
}

function timingText(t: TFunction, elapsed: number, usual: number, active: boolean): string {
    if (elapsed == null) {
        return active ? null : t("mc.remote.unknownDuration");
    }
    const spent = formatDuration(elapsed);
    if (!usual) {
        return spent;
    }
    return t(active ? "mc.remote.elapsedUsually" : "mc.remote.tookUsually", {
        elapsed: spent,
        usual: usualText(usual),
    });
}

function jobIconState(job: BranchCiJob) {
    if (job.status === "in_progress" || job.status === "queued" || job.status === "waiting") {
        return githubRunIconState(job.status, "");
    }
    return checkIconState(job.state);
}

function BranchJobs({ run, now }: { run: BranchCiRun; now: number }) {
    const t = useT();
    if (run.jobserror) {
        return (
            <div className="px-3 pb-2">
                <Problem text={run.jobserror} />
            </div>
        );
    }
    if (run.jobs.length === 0) {
        return null;
    }
    return (
        <ul
            className="flex flex-col gap-0.5 px-3 pb-2 pl-9"
            aria-label={t("mc.remote.jobsOf", { workflow: run.workflowName })}
        >
            {run.jobs.map((job) => {
                const icon = jobIconState(job);
                const active = job.status !== "completed";
                return (
                    <li key={job.name} className="flex flex-col" data-testid="ci-branch-job" data-state={icon}>
                        <div className="flex items-center gap-2 text-12">
                            <CiIcon state={icon} />
                            <span className="min-w-0 flex-1 truncate">{job.name}</span>
                            <span className="shrink-0 text-11 text-muted" data-testid="ci-branch-job-timing">
                                {icon === "queued"
                                    ? CiIconLabels.queued
                                    : timingText(t, jobElapsedMs(job, now), job.usualms, active)}
                            </span>
                        </div>
                        {job.failedsteps?.length ? (
                            <div className="pl-5 text-11 text-danger" data-testid="ci-branch-job-failed">
                                {t("mc.remote.failedStepsList", { steps: job.failedsteps.join(", ") })}
                            </div>
                        ) : null}
                    </li>
                );
            })}
        </ul>
    );
}

function AwaitedChip({ tag, onShowRelease }: { tag: string; onShowRelease: () => void }) {
    const t = useT();
    return (
        <button
            type="button"
            onClick={onShowRelease}
            className="mt-1 flex cursor-pointer items-center gap-1.5 rounded-4 border border-accent/50 bg-accent/10 px-1.5 py-0.5 text-11 text-primary hover:bg-accent/20"
            title={t("mc.remote.awaitedTitle")}
            data-testid="ci-branch-awaited"
        >
            <i className="fa fa-solid fa-tower-broadcast text-11 text-accent" />
            {t("mc.remote.awaitedBy", { tag })}
        </button>
    );
}

// The trunk and release branches' CI (#836): what a release waits on, the latest run of each workflow, its jobs, how
// long they take against their usual time, and the release waiting for it.
function BranchesCiBlock({
    dir,
    githubAt,
    onRefresh,
    onShowRelease,
}: {
    dir: string;
    githubAt: number;
    onRefresh: () => void;
    onShowRelease: () => void;
}) {
    const { answer, error, reload } = useBranchCi(dir, String(githubAt ?? ""));
    const panelId = usePanelBlockId();
    const [now, setNow] = useState(() => Date.now());
    const active = (answer?.branches ?? []).some((b) => b.runs.some((r) => r.status !== "completed"));
    useEffect(() => {
        if (!active) {
            return;
        }
        return everyInPanel(panelId, whileShown(ClockTickMs), () => setNow(Date.now()), "mission-branch-ci-clock");
    }, [active, panelId]);
    const refresh = () => {
        reload();
        onRefresh();
    };
    return (
        <BranchesCiList
            dir={dir}
            answer={answer}
            error={error}
            now={now}
            onRefresh={refresh}
            onShowRelease={onShowRelease}
        />
    );
}

export function BranchesCiList({
    dir,
    answer,
    error,
    now,
    onRefresh,
    onShowRelease,
}: {
    dir: string;
    answer: BranchCiAnswer;
    error: unknown;
    now: number;
    onRefresh: () => void;
    onShowRelease: () => void;
}) {
    const t = useT();
    return (
        <section className="flex flex-col gap-2" data-testid="ci-branches">
            <BlockHeader title={t("mc.remote.branchesTitle")} hint={t("mc.remote.branchesHint")} />
            {error ? <Problem text={serverErrorText(error)} /> : null}
            {(answer == null || !answer.state) && !error ? (
                <div className="overflow-hidden rounded-4 border border-border">
                    <Placeholder rows={2} />
                </div>
            ) : null}
            {(answer?.branches ?? []).map((branch) => (
                <div
                    key={branch.branch}
                    className="overflow-hidden rounded-4 border border-border"
                    data-testid="ci-branch"
                    data-branch={branch.branch}
                >
                    <div className="flex items-center gap-2 border-b border-border bg-hover/50 px-3 py-1.5">
                        <i className="fa fa-solid fa-code-branch text-11 text-muted" />
                        <code className="text-12 font-medium">{branch.branch}</code>
                        {branch.roles.map((role) => (
                            <span key={role} className="rounded-4 border border-border px-1 text-11 text-muted">
                                {t(`mc.remote.role.${role}`)}
                            </span>
                        ))}
                    </div>
                    {branch.error ? (
                        <div className="p-3">
                            <Problem text={branch.error} />
                        </div>
                    ) : null}
                    {!branch.error && branch.runs.length === 0 ? (
                        <p className="p-3 text-13 leading-5 text-muted">
                            {t("mc.remote.noBranchRun", { branch: branch.branch })}
                        </p>
                    ) : null}
                    {branch.runs.map((run) => (
                        <RunRow
                            key={run.databaseId}
                            run={run}
                            dir={dir}
                            onRefresh={onRefresh}
                            timing={
                                githubRunIconState(run.status, run.conclusion) === "queued"
                                    ? undefined
                                    : timingText(t, runElapsedMs(run, now), run.usualms, run.status !== "completed")
                            }
                            badge={
                                run.awaitedby ? <AwaitedChip tag={run.awaitedby} onShowRelease={onShowRelease} /> : null
                            }
                        >
                            <BranchJobs run={run} now={now} />
                        </RunRow>
                    ))}
                </div>
            ))}
        </section>
    );
}

export function RemoteCiTab({
    github,
    trunk,
    prTarget,
    dir,
    githubAt,
    onRefresh,
    onShowRelease,
}: {
    github: MissionGithub;
    trunk: string;
    prTarget?: string;
    dir: string;
    githubAt?: number;
    onRefresh: () => void;
    onShowRelease: () => void;
}) {
    const stateMessage = githubStateMessage(github);
    if (stateMessage) {
        return <Notice text={stateMessage} />;
    }
    return (
        <div className="flex flex-col gap-5">
            <ReviewsLine github={github} target={prTarget || trunk} dir={dir} />
            <BranchesCiBlock dir={dir} githubAt={githubAt} onRefresh={onRefresh} onShowRelease={onShowRelease} />
            {/* grid-cols-1 caps the column at the panel's width, so the rows truncate and keep their duration. */}
            <div className="grid grid-cols-1 gap-5 @3xl:grid-cols-2">
                <ScheduledBlock github={github} />
                <RecentRunsBlock github={github} dir={dir} onRefresh={onRefresh} />
            </div>
        </div>
    );
}

const KindLabels: Record<RegistryKind, string> = labelRecord("mc.registry.kind", ["planned", "rc", "public"]);

const KindIcons: Record<RegistryKind, string> = {
    planned: "fa-map-pin text-muted",
    rc: "fa-flag text-warning",
    public: "fa-box text-accent",
};

const RowButton =
    "flex shrink-0 cursor-pointer items-center gap-1 rounded-6 border border-border px-1.5 py-0.5 text-11 text-secondary hover:bg-hover hover:text-primary";

function RegistryLine({ row, repoUrl, github }: { row: RegistryRow; repoUrl: string; github: MissionGithub }) {
    const t = useT();
    const [notes, setNotes] = useState(false);
    const link =
        row.kind === "planned"
            ? row.milestone?.url
            : repoUrl
              ? `${repoUrl}/releases/tag/${encodeURIComponent(row.tag)}`
              : "";
    const total = (row.milestone?.open ?? 0) + (row.milestone?.closed ?? 0);
    return (
        <div
            className="border-b border-border px-3 py-2 last:border-b-0"
            data-testid="registry-row"
            data-kind={row.kind}
        >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <i className={cn("fa fa-solid text-11", KindIcons[row.kind])} />
                <span
                    className={cn(
                        "font-mono text-13 leading-5 font-medium",
                        row.kind === "planned" && "text-secondary"
                    )}
                >
                    {row.tag}
                </span>
                <span className="rounded-4 border border-border px-1 text-11 text-muted">{KindLabels[row.kind]}</span>
                {row.github?.latest ? (
                    <span className="rounded-4 bg-accent/20 px-1 text-11 text-primary">{t("mc.registry.latest")}</span>
                ) : null}
                {row.github?.draft ? (
                    <span className="rounded-4 border border-warning/50 px-1 text-11 text-warning">
                        {t("mc.registry.draft")}
                    </span>
                ) : null}
                {row.kind !== "planned" && !row.github && github?.state === "ok" ? (
                    <span className="text-11 text-muted">{t("mc.registry.tagOnly")}</span>
                ) : null}
                {row.builds.map((b) => (
                    <span
                        key={b}
                        className="flex items-center gap-1 rounded-4 border border-border px-1 text-11 text-secondary"
                        title={t("mc.registry.builtTitle", { build: b })}
                    >
                        <i className="fa fa-solid fa-hammer text-11 text-muted" />
                        {t("mc.registry.built", { build: b })}
                    </span>
                ))}
                {row.milestone ? (
                    <span className="text-11 text-muted" title={row.milestone.title}>
                        {total === 0
                            ? t("mc.registry.noIssue")
                            : t("mc.registry.issuesClosed", { closed: row.milestone.closed, total })}
                    </span>
                ) : null}
                <span className="ml-auto flex items-center gap-1.5">
                    {row.date ? (
                        <span className="text-12 text-muted" title={formatWhen(row.date)}>
                            {row.kind === "planned"
                                ? t("mc.registry.due", { when: timeAgo(row.date) })
                                : timeAgo(row.date)}
                        </span>
                    ) : null}
                    {row.notes ? (
                        <button
                            type="button"
                            className={RowButton}
                            aria-expanded={notes}
                            onClick={() => setNotes(!notes)}
                        >
                            {notes ? t("mc.registry.hideNotes") : t("mc.registry.notes")}
                        </button>
                    ) : null}
                    {link ? (
                        <button
                            type="button"
                            className={RowButton}
                            onClick={() => open(link)}
                            title={
                                row.kind === "planned" ? t("mc.registry.openMilestone") : t("mc.registry.openRelease")
                            }
                        >
                            <i className="fa fa-solid fa-arrow-up-right-from-square text-11" />
                            {t("common.open")}
                        </button>
                    ) : null}
                </span>
            </div>
            {notes && row.notes ? (
                <pre className="mt-2 max-h-64 overflow-auto rounded-6 border border-border bg-black/30 px-2 py-1.5 font-sans text-12 leading-relaxed whitespace-pre-wrap text-secondary">
                    {row.notes}
                </pre>
            ) : null}
        </div>
    );
}

export function CdTab({
    git,
    github,
    pipeline,
    runs,
}: {
    git: MissionGit;
    github: MissionGithub;
    pipeline: PipelineReport;
    runs: RunRecord[];
}) {
    const t = useT();
    const registry = useMemo(() => tagRegistry(git, github, runs), [git, github, runs]);
    const repoUrl = github?.url || git?.remoteurl;
    const builds = pipeline?.valid ? (pipeline.pipeline?.builds ?? []) : [];
    return (
        <div className="flex flex-col gap-5">
            <section className="flex flex-col gap-2">
                <BlockHeader title={t("mc.registry.localBuilds")} hint={t("mc.registry.localBuildsHint")} />
                {builds.length === 0 ? (
                    <Notice text={t("mc.registry.noBuildDeclared")} />
                ) : (
                    <div className="overflow-hidden rounded-4 border border-border">
                        <RecentBuilds runs={runs} />
                    </div>
                )}
            </section>
            <section className="flex flex-col gap-2">
                <BlockHeader title={t("mc.registry.title")} hint={t("mc.registry.hint")} />
                {githubStateMessage(github) ? <Notice text={githubStateMessage(github)} /> : null}
                <div className="overflow-hidden rounded-4 border border-border">
                    {registry.length === 0 ? (
                        <p className="p-3 text-13 leading-5 text-muted">{t("mc.registry.noTag")}</p>
                    ) : null}
                    {registry.map((row) => (
                        <RegistryLine key={`${row.kind}:${row.tag}`} row={row} repoUrl={repoUrl} github={github} />
                    ))}
                </div>
            </section>
        </div>
    );
}
