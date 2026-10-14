// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The tabs of the CI/CD workshop (FR-MC-025, formerly FR-MC-002). CI remote is ported from Notulia's Dev › CI
// (GithubPanels.tsx): open pull requests with their checks, scheduled workflows with their next runs, recent runs. CD
// holds the local builds with their logs and the full tag registry. Summaries and actions live in Project (DS-MC-012).

import { openWebLink } from "@/moltenterm-shell/open-web-link";
import { cn, fireAndForget } from "@/util/util";
import { useMemo, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { isReviewable } from "../reviews/reviews-model";
import { ReviewsModel } from "../reviews/reviews-store";
import { checkIconState, CiIcon, CiIconLabels, githubRunIconState } from "./ci-icon";
import { ActionRowClass, RerunConfirm, RowAction, RowActions } from "./ci-row-actions";
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
import { githubRunLog, githubRunRerun } from "./mission-client";
import { labelRecord } from "./mission-i18n";
import { githubStateMessage, MissionGit, MissionGithub, PipelineReport, RunRecord } from "./mission-model";
import { RecentBuilds } from "./runs-view";
import { RegistryKind, RegistryRow, tagRegistry } from "./tag-registry";
import { dateLocale, formatWhen, timeAgo } from "./time-format";

const ToneClasses: Record<CheckState, string> = {
    success: "border-success/40 bg-success/10 text-success",
    failure: "border-error/40 bg-error/10 text-error",
    pending: "border-warning/40 bg-warning/10 text-warning",
    neutral: "border-border bg-hover text-muted",
};

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
    return <div className="rounded-4 border border-error/40 bg-error/10 px-3 py-2 text-12 text-error">{text}</div>;
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

function PullRequestsBlock({
    github,
    trunk,
    dir,
    prTarget,
}: {
    github: MissionGithub;
    trunk: string;
    dir: string;
    prTarget: string;
}) {
    const t = useT();
    const prs = github?.prs;
    // The PRs the Reviews view lists get a Review action (FR-REV-001-AC3).
    const reviewTarget = prTarget || trunk;
    return (
        <section className="flex flex-col gap-2">
            <BlockHeader title={t("mc.remote.prsTitle")} hint={t("mc.remote.prsHint")} />
            {github?.errors?.prs ? <Problem text={github.errors.prs} /> : null}
            <div className="overflow-hidden rounded-4 border border-border">
                {github == null ? <Placeholder rows={3} /> : null}
                {github != null && (prs ?? []).length === 0 && !github.errors?.prs ? (
                    <p className="p-3 text-13 leading-5 text-muted">{t("mc.remote.noPr")}</p>
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
                                    <div className="truncate text-13 leading-5 font-medium">
                                        <span className="text-muted">#{pr.number}</span> {pr.title}
                                    </div>
                                    <div className="truncate text-12 text-muted">
                                        <code>{pr.headRefName}</code> → <code>{pr.baseRefName}</code> ·{" "}
                                        {t("mc.remote.updated")} {timeAgo(pr.updatedAt)}
                                    </div>
                                </div>
                                <div className="flex shrink-0 items-center gap-1.5">
                                    {dir && isReviewable(pr, reviewTarget) ? (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                fireAndForget(() =>
                                                    ReviewsModel.getInstance().openReviews(dir, pr.number)
                                                )
                                            }
                                            className="flex cursor-pointer items-center gap-1.5 rounded-6 border border-border px-2 py-1 text-12 hover:bg-hover"
                                            title={t("mc.remote.openInReviews")}
                                            data-testid="mission-pr-review"
                                        >
                                            <i className="fa fa-solid fa-code-pull-request text-11" />
                                            {t("mc.remote.review")}
                                        </button>
                                    ) : null}
                                    <button
                                        type="button"
                                        onClick={() => open(pr.url)}
                                        className="flex cursor-pointer items-center gap-1.5 rounded-6 border border-border px-2 py-1 text-12 hover:bg-hover"
                                        title={t("mc.remote.openOnGithub")}
                                    >
                                        <i className="fa fa-solid fa-arrow-up-right-from-square text-11" />
                                        {t("common.open")}
                                    </button>
                                </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                                <span className={cn("rounded-4 border px-2 py-0.5 text-12", ToneClasses[merge.tone])}>
                                    {merge.label}
                                </span>
                                {checks.map((c) => (
                                    <span
                                        key={c.name}
                                        className="flex items-center gap-1 rounded-4 border border-border px-1.5 py-0.5 text-12"
                                        title={c.local ? t("mc.remote.localCheck") : t("mc.remote.githubJob")}
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
    const t = useT();
    const schedules = useMemo(() => scheduledWorkflows(github?.workflows ?? []), [github?.workflows]);
    const now = new Date();
    return (
        <section className="flex flex-col gap-2">
            <BlockHeader title={t("mc.remote.scheduledTitle")} hint={t("mc.remote.scheduledHint")} />
            <div className="overflow-hidden rounded-4 border border-border">
                {github == null ? <Placeholder rows={2} /> : null}
                {github != null && schedules.length === 0 ? (
                    <p className="p-3 text-13 leading-5 text-muted">{t("mc.remote.noScheduled")}</p>
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
                className="max-h-64 overflow-auto rounded-4 bg-black/50 p-2 font-mono text-11 leading-snug whitespace-pre-wrap text-[#e5e7eb]"
            >
                {log.text === "" ? t("mc.run.noOutput") : log.text}
            </pre>
        </>
    );
}

// A GitHub run's row (FR-SHELL-057): its state as a shape, then Logs (read in the row through gh), Rerun (after a
// question; the failed jobs of a red run) and GitHub, on hover and focus.
function RunRow({ run, dir, onRefresh }: { run: WorkflowRun; dir: string; onRefresh: () => void }) {
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
                setLog({ text: "", error: String(e?.message ?? e) });
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
                setError(String(e?.message ?? e));
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
                            {active
                                ? CiIconLabels[icon]
                                : formatDuration(new Date(run.updatedAt).getTime() - new Date(run.createdAt).getTime())}
                        </span>
                    </div>
                    <div className="truncate text-12 text-muted">
                        <code>{run.headBranch}</code> · {timeAgo(run.createdAt)} · {run.displayTitle}
                    </div>
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

export function RemoteCiTab({
    github,
    trunk,
    prTarget,
    dir,
    onRefresh,
}: {
    github: MissionGithub;
    trunk: string;
    prTarget?: string;
    dir: string;
    onRefresh: () => void;
}) {
    const stateMessage = githubStateMessage(github);
    if (stateMessage) {
        return <Notice text={stateMessage} />;
    }
    return (
        <div className="flex flex-col gap-5">
            <PullRequestsBlock github={github} trunk={trunk} dir={dir} prTarget={prTarget} />
            <div className="grid gap-5 @3xl:grid-cols-2">
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
