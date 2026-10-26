// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The release in flight (FR-MC-016), as Notulia's ReleaseRunPanel: five phases, where it is, what it waits on, and why
// it is stuck when it is. Each phase has at most one button, the next thing to do there (after a failure, the step
// before the failed one is offered again beside it); the cut says what cannot be taken back before it lands, and
// while it waits its public notes are read and edited here.

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useMemo, useState } from "react";
import { t, useLocale, useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { openWebLink } from "../open-web-link";
import { askReleaseResolve } from "../review/review-client";
import { showStartedAgent } from "../reviews/agent-choice";
import { DominoLoader } from "../suite/suite";
import { whileShown } from "../tab-activity";
import { everyInPanel, usePanelBlockId } from "../view360/offcarpet-model";
import type { ReleaseCiAwait } from "./branch-ci";
import { openCicdTab } from "./cicd-open";
import {
    githubRunRerun,
    missionLog,
    missionTrust,
    releaseDispatchWorkflow,
    releaseEnd,
    releaseNotes,
    releaseNotesSave,
    releaseRerunFailed,
    releaseRunStep,
    useReleaseFacts,
} from "./mission-client";
import { labelRecord } from "./mission-i18n";
import { latestRun, ManualCheckFailure, PipelineDef, ReleasePhase, RunRecord, UntrustedInfo } from "./mission-model";
import {
    ActionOutcome,
    PendingLock,
    PendingLockContext,
    runAction,
    useCardLock,
    usePendingLock,
} from "./pending-action";
import { ReleaseSession } from "./release-model";
import { ReleaseFailureActions, ReleaseResolveActions } from "./release-resolve";
import {
    ChangelogScope,
    Phase,
    PhaseAction,
    PhaseStatus,
    PreparationStep,
    ReleaseFormat,
    ReleaseGhJob,
    ReleaseRun,
    releaseRun,
} from "./release-run";
import { TrustPrompt } from "./runs-view";

const NodeClasses: Record<PhaseStatus, string> = {
    done: "border-success/60 bg-success/10 text-success",
    running: "border-accent/70 bg-accent/15 text-accent",
    waiting: "border-warning/60 bg-warning/10 text-warning",
    failed: "border-error/60 bg-error/10 text-error",
    todo: "border-border bg-transparent text-muted",
};

const Says: Record<PhaseStatus, string> = labelRecord("mc.releaseRun.says", [
    "done",
    "running",
    "waiting",
    "failed",
    "todo",
]);

const ShortTitles: Record<ReleasePhase, string> = labelRecord("mc.releaseRun.short", [
    "prepare",
    "cut",
    "build",
    "publish",
    "back",
]);

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";
const AccentButton =
    "molten-btn cursor-pointer rounded-6 px-3 py-1 text-12 disabled:cursor-default disabled:opacity-50";

export type ReleasePanelActions = {
    // Resolves true when a step started: the card stays pending until it read the release again. A manual step whose
    // check failed is recorded only once confirmed: onUnproved hears what is missing, and the action resolves false.
    run: (action: PhaseAction, onUnproved?: (failure: ManualCheckFailure) => void) => Promise<boolean | void>;
    loadNotes: () => Promise<string>;
    saveNotes: (text: string) => Promise<void>;
} & Partial<ReleaseResolveActions>;

function StatusIcon({ status, small }: { status: PhaseStatus; small?: boolean }) {
    switch (status) {
        case "done":
            return <i className="fa fa-solid fa-check text-11" />;
        case "running":
            return <DominoLoader className={small ? "mt-dominos-icon" : "mt-dominos-node"} />;
        case "waiting":
            return <i className="fa fa-solid fa-hand text-11" />;
        case "failed":
            return <i className="fa fa-solid fa-xmark text-11" />;
    }
    return <span className="block h-1.5 w-1.5 rounded-full bg-current opacity-60" />;
}

function jobStatus(job: ReleaseGhJob): PhaseStatus {
    if (job.status !== "completed") {
        return job.startedAt ? "running" : "todo";
    }
    if (job.conclusion === "success") {
        return "done";
    }
    return job.conclusion === "skipped" ? "todo" : "failed";
}

function jobDuration(job: ReleaseGhJob, now: number): string {
    if (!job.startedAt) {
        return "";
    }
    const end = job.completedAt ? new Date(job.completedAt).getTime() : now;
    const s = Math.max(0, Math.round((end - new Date(job.startedAt).getTime()) / 1000));
    if (s < 60) {
        return `${s}s`;
    }
    const m = Math.floor(s / 60);
    return m >= 10 ? `${m}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

function Jobs({ jobs }: { jobs: ReleaseGhJob[] }) {
    const [now, setNow] = useState(Date.now());
    const running = jobs.some((j) => j.status !== "completed");
    const panelId = usePanelBlockId();
    useEffect(() => {
        if (!running) {
            return;
        }
        return everyInPanel(panelId, whileShown(1000), () => setNow(Date.now()), "clock");
    }, [running, panelId]);
    return (
        <ul className="mt-3 flex flex-col gap-1">
            {jobs.map((job) => {
                const status = jobStatus(job);
                return (
                    <li key={job.name} className="flex items-center gap-2 text-12">
                        <span
                            className={cn(
                                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-11",
                                NodeClasses[status]
                            )}
                        >
                            <StatusIcon status={status} small />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-secondary">{job.name}</span>
                        <span className="text-muted tabular-nums">{jobDuration(job, now)}</span>
                    </li>
                );
            })}
        </ul>
    );
}

// Every release action and how it ended goes to waveapp.log: the panel's clicks are otherwise nowhere to be read back
// (#1091).
export function logReleaseAction(text: string) {
    try {
        getApi()?.sendLog(`[release] ${text}`);
    } catch {
        // No log outside the app (tests, the preview server).
    }
}

// Sends a phase's action under the card's lock. A manual step whose check failed comes back asked with what is missing
// (#1095); force sends it again as confirmed anyway.
export async function sendAction(
    lock: PendingLock,
    key: string,
    actions: ReleasePanelActions,
    action: PhaseAction,
    force?: boolean
): Promise<{ outcome: ActionOutcome; failure: ManualCheckFailure }> {
    const sent: PhaseAction = force && action.kind === "step" ? { ...action, force: true } : action;
    let failure: ManualCheckFailure = null;
    const outcome = await runAction(lock, key, () =>
        actions.run(sent, (f) => {
            failure = f;
        })
    );
    return { outcome, failure: outcome === "asked" ? failure : null };
}

const MaxUncoveredShown = 12;

// A public changelog section that leaves out changes since the last public release (#1142): listed, to be confirmed.
export function UncoveredNote({ failure }: { failure: ManualCheckFailure }) {
    const t = useT();
    const items = failure.uncovered ?? [];
    const shown = items.slice(0, MaxUncoveredShown);
    const vars = { version: failure.version || failure.contains, path: failure.path, since: failure.since };
    return (
        <div
            className="flex items-start gap-1.5 rounded-4 border border-warning/40 bg-warning/10 px-2 py-1.5 text-12 text-secondary"
            data-testid="release-run-uncovered"
        >
            <i className="fa fa-solid fa-triangle-exclamation mt-0.5 text-11 text-warning" />
            <div className="flex min-w-0 flex-col gap-1">
                <span className="break-words">
                    {failure.since ? t("mc.releaseRun.uncovered", vars) : t("mc.releaseRun.uncoveredFirst", vars)}
                </span>
                <ul className="flex flex-col gap-0.5 text-primary">
                    {shown.map((item) => (
                        <li key={item.ticket ? `#${item.ticket}` : item.text} className="break-words">
                            {item.ticket ? <span className="mr-1.5 font-mono text-11">#{item.ticket}</span> : null}
                            {item.text}
                        </li>
                    ))}
                </ul>
                {items.length > shown.length ? (
                    <span className="text-muted">
                        {t("mc.releaseRun.uncoveredMore", { count: items.length - shown.length })}
                    </span>
                ) : null}
                <span>{t("mc.releaseRun.uncoveredHint")}</span>
            </div>
        </div>
    );
}

// What a changelog section covers (#1142), said on its manual step.
function ScopeNote({ scope, withNotes }: { scope: ChangelogScope; withNotes: boolean }) {
    const t = useT();
    let text: string;
    if (scope.public) {
        text = scope.since
            ? t("mc.releaseRun.scopePublic", { since: scope.since })
            : t("mc.releaseRun.scopePublicFirst");
    } else {
        text = scope.since ? t("mc.releaseRun.scopeRc", { since: scope.since }) : t("mc.releaseRun.scopeRcFirst");
    }
    return (
        <p
            className="mt-2 flex items-start gap-1.5 rounded-4 border border-border bg-hover/40 px-2 py-1.5 text-12 text-secondary"
            data-testid="release-run-scope"
        >
            <i className="fa fa-solid fa-list-check mt-0.5 text-11 text-accent" />
            <span className="min-w-0 break-words">
                {text}
                {scope.public && withNotes ? ` ${t("mc.releaseRun.scopeSource")}` : null}
            </span>
        </p>
    );
}

function ActionButton({
    action,
    actions,
    plain,
}: {
    action: PhaseAction;
    actions: ReleasePanelActions;
    // A secondary way forward, beside the phase's own action.
    plain?: boolean;
}) {
    const t = useT();
    const lock = useCardLock();
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string>(null);
    const [notice, setNotice] = useState<string>(null); // an i18n key, worded at render: the language may change meanwhile
    const [unproved, setUnproved] = useState<ManualCheckFailure>(null);
    const confirm = action.kind === "step" || action.kind === "dispatch" ? action.confirm : null;
    const key = `${plain ? "redo" : "action"}:${action.label}`;
    const busy = lock.pending === key;
    const go = (force?: boolean) =>
        fireAndForget(async () => {
            setError(null);
            setNotice(null);
            setUnproved(null);
            try {
                const { outcome, failure } = await sendAction(lock, key, actions, action, force);
                if (outcome === "refused") {
                    logReleaseAction(`${action.label}: not sent, another action of the card is under way`);
                    setNotice("mc.releaseRun.actionRefused");
                    return;
                }
                if (outcome === "asked" && failure != null) {
                    setConfirming(false);
                    setUnproved(failure);
                    return;
                }
                if (outcome === "asked") {
                    setNotice("mc.releaseRun.trustFirst");
                    return;
                }
                setConfirming(false);
            } catch (e) {
                const text = serverErrorText(e) || t("mc.releaseRun.actionFailed");
                logReleaseAction(`${action.label}: ${text}`);
                setError(text);
            }
        });
    if (unproved != null) {
        return (
            <div className="mt-3 flex flex-col gap-2" data-testid="release-run-unproved">
                {unproved.uncovered?.length > 0 ? (
                    <UncoveredNote failure={unproved} />
                ) : (
                    <p className="flex items-start gap-1.5 rounded-4 border border-warning/40 bg-warning/10 px-2 py-1.5 text-12 text-warning">
                        <i className="fa fa-solid fa-triangle-exclamation mt-0.5 text-11" />
                        <span className="min-w-0 break-words">
                            {unproved.missing
                                ? t("mc.releaseRun.uncheckedMissing", { path: unproved.path, dir: unproved.dir })
                                : t("mc.releaseRun.uncheckedLacks", {
                                      path: unproved.path,
                                      contains: unproved.contains,
                                      dir: unproved.dir,
                                  })}
                        </span>
                    </p>
                )}
                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        disabled={lock.pending !== ""}
                        className={PlainButton}
                        onClick={() => setUnproved(null)}
                    >
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        disabled={lock.pending !== ""}
                        aria-busy={busy}
                        className={cn(PlainButton, "inline-flex items-center")}
                        onClick={() => go(true)}
                        data-testid="release-run-mark-anyway"
                    >
                        {busy ? <DominoLoader className="mr-1.5" /> : null}
                        {busy ? (action.busy ?? action.label) : t("mc.releaseRun.markDoneAnyway")}
                    </button>
                </div>
                {error ? (
                    <p className="text-right text-12 text-danger" role="alert">
                        {error}
                    </p>
                ) : null}
            </div>
        );
    }
    return (
        <div className="mt-3 flex flex-col gap-2">
            {confirming && confirm ? (
                <p className="rounded-4 border border-warning/40 bg-warning/10 px-2 py-1.5 text-12 text-warning">
                    {confirm}
                </p>
            ) : null}
            <div className="flex justify-end gap-2">
                {confirming ? (
                    <button
                        type="button"
                        disabled={lock.pending !== ""}
                        className={PlainButton}
                        onClick={() => setConfirming(false)}
                    >
                        {t("common.cancel")}
                    </button>
                ) : null}
                <button
                    type="button"
                    disabled={lock.pending !== ""}
                    aria-busy={busy}
                    className={cn(plain ? PlainButton : AccentButton, "inline-flex items-center")}
                    onClick={() => (confirm && !confirming ? setConfirming(true) : go())}
                    data-testid={plain ? "release-run-redo" : "release-run-action"}
                >
                    {busy ? <DominoLoader className="mr-1.5" /> : null}
                    {busy ? (action.busy ?? action.label) : confirming ? t("common.confirm") : action.label}
                    {plain ? null : <MoltenWave />}
                </button>
            </div>
            {notice ? (
                <p className="text-right text-12 text-warning" role="status" data-testid="release-run-notice">
                    {t(notice)}
                </p>
            ) : null}
            {error ? (
                <p className="text-right text-12 text-danger" role="alert">
                    {error}
                </p>
            ) : null}
        </div>
    );
}

function PendingLabel({ busy, label, idle }: { busy: boolean; label: string; idle: string }) {
    return (
        <>
            {busy ? <DominoLoader className="mr-1.5" /> : null}
            {busy ? label : idle}
        </>
    );
}

function NotesEditor({
    actions,
    rewrite,
    onDirty,
}: {
    actions: ReleasePanelActions;
    rewrite: PhaseAction;
    onDirty: (dirty: boolean) => void;
}) {
    const t = useT();
    const [text, setText] = useState<string>(null);
    const [saved, setSaved] = useState<string>(null);
    const lock = useCardLock();
    const [error, setError] = useState<string>(null);
    const locked = lock.pending !== "";
    const runLocked = (key: string, fn: () => Promise<boolean | void>) =>
        fireAndForget(async () => {
            setError(null);
            try {
                await lock.run(key, fn);
            } catch (e) {
                setError(serverErrorText(e));
            }
        });
    const load = () =>
        fireAndForget(async () => {
            try {
                const next = await actions.loadNotes();
                setText(next);
                setSaved(next);
            } catch (e) {
                setError(serverErrorText(e));
            }
        });
    useEffect(load, [actions]);
    const dirty = text != null && text !== saved;
    useEffect(() => onDirty(dirty), [dirty]);
    if (text == null) {
        return error ? <p className="mt-3 text-12 text-danger">{error}</p> : null;
    }
    return (
        <div className="mt-3 flex flex-col gap-2">
            <div className="text-11 text-muted">{t("mc.releaseRun.publicNotes")}</div>
            <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="min-h-48 rounded-4 border border-border bg-transparent p-2 font-mono text-12 text-primary"
            />
            <div className="flex justify-end gap-2">
                {rewrite ? (
                    <button
                        type="button"
                        disabled={locked}
                        aria-busy={lock.pending === "notes:rewrite"}
                        className={cn(PlainButton, "inline-flex items-center")}
                        onClick={() => runLocked("notes:rewrite", () => actions.run(rewrite))}
                        data-testid="release-run-rewrite"
                    >
                        <PendingLabel
                            busy={lock.pending === "notes:rewrite"}
                            label={t("mc.releaseRun.pending.rewriting")}
                            idle={t("mc.releaseRun.rewrite")}
                        />
                    </button>
                ) : null}
                <button
                    type="button"
                    disabled={!dirty || locked}
                    aria-busy={lock.pending === "notes:save"}
                    className={cn(PlainButton, "inline-flex items-center")}
                    onClick={() =>
                        runLocked("notes:save", async () => {
                            await actions.saveNotes(text);
                            setSaved(text);
                        })
                    }
                    data-testid="release-run-save-notes"
                >
                    <PendingLabel
                        busy={lock.pending === "notes:save"}
                        label={t("mc.releaseRun.pending.saving")}
                        idle={t("common.save")}
                    />
                </button>
            </div>
            {error ? (
                <p className="text-right text-12 text-danger" role="alert">
                    {error}
                </p>
            ) : null}
        </div>
    );
}

// The files the release wrote are not formatted the way the project checks (#1095): said before the commit, with the
// command to run when the formatter failed.
function UnformattedNote({ format }: { format: ReleaseFormat }) {
    const t = useT();
    const failed = format.state === "failed";
    return (
        <div
            className={cn(
                "mt-2 flex items-start gap-1.5 rounded-4 border px-2 py-1.5 text-12",
                failed ? "border-warning/40 bg-warning/10 text-secondary" : "border-border bg-hover/40 text-secondary"
            )}
            data-testid="release-run-unformatted"
        >
            <i
                className={cn(
                    "fa fa-solid mt-0.5 text-11",
                    failed ? "fa-triangle-exclamation text-warning" : "fa-circle-info text-muted"
                )}
            />
            <div className="flex min-w-0 flex-col gap-1">
                <span>{failed ? t("mc.releaseRun.formatFailed") : t("mc.releaseRun.formatNone")}</span>
                {failed && format.command ? (
                    <code className="font-mono text-11 break-all text-primary">{format.command}</code>
                ) : null}
            </div>
        </div>
    );
}

function Detail({
    run,
    phase,
    jobs,
    actions,
    awaits,
}: {
    run: ReleaseRun;
    phase: Phase;
    jobs: ReleaseGhJob[];
    actions: ReleasePanelActions;
    awaits?: ReleaseCiAwait;
}) {
    const t = useT();
    const [notesDirty, setNotesDirty] = useState(false);
    const editing = phase.id === "cut" && run.editNotes;
    const rewrite: PhaseAction = run.notesStep
        ? { kind: "step", step: run.notesStep.id, label: run.notesStep.title || run.notesStep.id }
        : null;
    const tail = phase.log?.tail ?? [];
    return (
        <div
            className="mt-4 rounded-10 border border-border bg-black/20 p-3"
            data-testid={`release-run-detail-${phase.id}`}
        >
            <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-13 leading-5 font-medium text-primary">{phase.title}</h3>
                <span className="text-11 text-muted">{Says[phase.status]}</span>
            </div>
            <p className="mt-1 text-12 text-secondary">{phase.expect}</p>
            {phase.manual ? (
                <p
                    className="mt-2 flex items-start gap-1.5 rounded-4 border border-border bg-hover/40 px-2 py-1.5 text-12 whitespace-pre-wrap text-primary"
                    data-testid="release-run-manual"
                >
                    <i className="fa fa-solid fa-hand mt-0.5 text-11 text-accent" />
                    {phase.manual}
                </p>
            ) : null}
            {phase.scope ? <ScopeNote scope={phase.scope} withNotes={editing} /> : null}
            {phase.approval ? (
                <p
                    className="mt-2 flex items-start gap-1.5 rounded-4 border border-warning/40 bg-warning/10 px-2 py-1.5 text-12 text-secondary"
                    data-testid="release-run-approval"
                >
                    <i className="fa fa-solid fa-user-check mt-0.5 text-11 text-warning" />
                    {t("mc.releaseRun.approvalHint", { environment: phase.approval.environment })}
                </p>
            ) : null}
            {awaits != null && phase.id === run.current ? (
                <div
                    className="mt-2 flex flex-wrap items-center gap-2 rounded-4 border border-warning/40 bg-warning/10 px-2 py-1.5 text-12 text-secondary"
                    data-testid="release-run-awaits-ci"
                >
                    <i className="fa fa-solid fa-hourglass-half text-11 text-warning" />
                    <span className="min-w-0 flex-1">
                        {t("mc.releaseRun.awaitsCi", {
                            branch: awaits.branch,
                            sha: awaits.sha.slice(0, 7),
                            workflows: (awaits.workflows ?? []).join(", ") || "CI",
                        })}
                    </span>
                    <button
                        type="button"
                        className="flex cursor-pointer items-center gap-1 rounded-6 border border-border px-2 py-0.5 text-11 text-secondary hover:bg-hover hover:text-primary"
                        onClick={() => fireAndForget(() => openCicdTab("remote"))}
                        data-testid="release-run-show-ci"
                    >
                        <i className="fa fa-solid fa-cloud text-11" />
                        {t("mc.releaseRun.showCi")}
                    </button>
                </div>
            ) : null}
            {phase.id === "cut" && phase.status !== "done" && run.unformatted ? (
                <UnformattedNote format={run.unformatted} />
            ) : null}
            {phase.cause ? (
                <p className="mt-2 flex items-start gap-1.5 rounded-4 border border-error/40 bg-error/10 px-2 py-1.5 text-12 text-danger">
                    <i className="fa fa-solid fa-triangle-exclamation mt-0.5 text-11" />
                    {phase.cause}
                </p>
            ) : null}
            {phase.id === "build" && jobs.length > 0 ? <Jobs jobs={jobs} /> : null}
            {phase.status !== "done" && tail.length > 0 ? (
                <pre className="mt-3 max-h-32 overflow-auto rounded-6 border border-border bg-black/30 px-2 py-1.5 font-mono text-11 leading-relaxed whitespace-pre-wrap text-secondary">
                    {tail.slice(-6).join("\n")}
                </pre>
            ) : null}
            {editing ? (
                <NotesEditor key={run.notesRevision} actions={actions} rewrite={rewrite} onDirty={setNotesDirty} />
            ) : null}
            {phase.links.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                    {phase.links.map((link) => (
                        <a
                            key={link.url}
                            href={link.url}
                            onClick={(e) => {
                                e.preventDefault();
                                fireAndForget(() => openWebLink(link.url));
                            }}
                            className="inline-flex cursor-pointer items-center gap-1 rounded-6 border border-border px-2 py-1 text-11 text-secondary hover:bg-hover hover:text-primary"
                        >
                            {link.label}
                            <i className="fa fa-solid fa-arrow-up-right-from-square text-11" />
                        </a>
                    ))}
                </div>
            ) : null}
            {actions.resolve && actions.rerunRuns ? (
                <ReleaseFailureActions
                    key={`${phase.id}:${phase.failure?.runid ?? ""}`}
                    phase={phase}
                    actions={{ resolve: actions.resolve, rerunRuns: actions.rerunRuns }}
                />
            ) : null}
            {phase.action ? (
                editing && notesDirty ? (
                    <p className="mt-3 text-right text-12 text-muted">{t("mc.releaseRun.saveBeforeCut")}</p>
                ) : (
                    <>
                        <ActionButton key={phase.action.label} action={phase.action} actions={actions} />
                        {phase.redo ? (
                            <ActionButton
                                key={`redo:${phase.redo.label}`}
                                action={phase.redo}
                                actions={actions}
                                plain
                            />
                        ) : null}
                    </>
                )
            ) : null}
        </div>
    );
}

export function ReleaseRunPanel({
    run,
    jobs,
    actions,
    onAbandon,
    awaits,
    lock,
    revision,
}: {
    run: ReleaseRun;
    jobs: ReleaseGhJob[];
    actions: ReleasePanelActions;
    // The branch CI a running step waits on (#836), shown with a link to the CI/CD panel.
    awaits?: ReleaseCiAwait;
    // Stops following it: the release launched from the Project tab ends, a tag cut at the terminal is no longer
    // followed.
    onAbandon?: () => Promise<void>;
    // The card's one-action-at-a-time lock (#952), when its owner also locks around it (the trust prompt).
    lock?: PendingLock;
    // Changes on each read of the release: a started step's button stays pending until then.
    revision?: unknown;
}) {
    const t = useT();
    const own = usePendingLock(revision);
    const cardLock = lock ?? own;
    const [picked, setPicked] = useState<ReleasePhase>(null);
    const [confirming, setConfirming] = useState(false);
    const [abandonError, setAbandonError] = useState<string>(null);
    const shown = run.phases.find((p) => p.id === (picked ?? run.current)) ?? run.phases[run.phases.length - 1];
    const locked = cardLock.pending !== "";
    const abandoning = cardLock.pending === "abandon";
    const abandon = () =>
        fireAndForget(async () => {
            setAbandonError(null);
            try {
                await cardLock.run("abandon", onAbandon);
            } catch (e) {
                setAbandonError(serverErrorText(e));
            }
        });
    return (
        <PendingLockContext.Provider value={cardLock}>
            <section
                className="rounded-6 border border-accent/40 bg-gradient-to-br from-accent/10 to-transparent p-4"
                data-testid="release-run"
            >
                <div className="mb-3 flex items-center gap-1.5 text-11 font-medium tracking-wide text-muted uppercase">
                    <i className="fa fa-solid fa-tower-broadcast text-accent" />
                    {t("mc.releaseRun.inFlight")}
                    <span className="ml-auto rounded-full border border-border px-2 py-0.5 font-mono tracking-normal text-primary normal-case">
                        {run.tag} ·{" "}
                        {run.channel === "rc" ? t("mc.releaseRun.internal") : t("mc.releaseRun.publicChannel")}
                    </span>
                </div>
                <ol className="flex items-start gap-1" aria-label={t("mc.releaseRun.phasesLabel")}>
                    {run.phases.map((p, i) => (
                        <li key={p.id} className="flex flex-1 items-center gap-1 last:flex-none">
                            <div className="flex flex-col items-center gap-1">
                                <button
                                    type="button"
                                    onClick={() => setPicked(p.id === picked ? null : p.id)}
                                    aria-current={p.id === run.current ? "step" : undefined}
                                    aria-label={`${p.title}: ${Says[p.status]}`}
                                    data-status={p.status}
                                    data-testid={`release-run-phase-${p.id}`}
                                    className={cn(
                                        "flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border",
                                        NodeClasses[p.status],
                                        p.id === shown.id && "ring-2 ring-accent/30"
                                    )}
                                >
                                    <StatusIcon status={p.status} />
                                </button>
                                <span
                                    className={cn(
                                        "text-11 whitespace-nowrap",
                                        p.id === run.current ? "text-primary" : "text-muted"
                                    )}
                                >
                                    {ShortTitles[p.id]}
                                </span>
                            </div>
                            {i < run.phases.length - 1 ? (
                                <span
                                    className={cn(
                                        "mb-4 h-px flex-1",
                                        p.status === "done" ? "bg-success/60" : "bg-border"
                                    )}
                                    aria-hidden
                                />
                            ) : null}
                        </li>
                    ))}
                </ol>
                <Detail run={run} phase={shown} jobs={jobs} actions={actions} awaits={awaits} />
                {onAbandon ? (
                    <div className="mt-3 flex items-center justify-end gap-2 text-11">
                        {confirming ? (
                            <>
                                <span className="text-muted">{t("mc.releaseRun.stopFollowing", { tag: run.tag })}</span>
                                <button
                                    type="button"
                                    disabled={locked}
                                    className={PlainButton}
                                    onClick={() => setConfirming(false)}
                                >
                                    {t("mc.releaseRun.no")}
                                </button>
                                <button
                                    type="button"
                                    disabled={locked}
                                    aria-busy={abandoning}
                                    className="inline-flex cursor-pointer items-center rounded-6 border border-error/50 px-2 py-1 text-12 text-danger hover:bg-error/10 disabled:cursor-default disabled:opacity-50"
                                    onClick={abandon}
                                    data-testid="release-run-abandon-yes"
                                >
                                    <PendingLabel
                                        busy={abandoning}
                                        label={t("mc.releaseRun.pending.abandoning")}
                                        idle={t("mc.releaseRun.abandon")}
                                    />
                                </button>
                            </>
                        ) : (
                            <button
                                type="button"
                                disabled={locked}
                                className="cursor-pointer rounded-6 px-2 py-1 text-muted hover:text-primary disabled:cursor-default disabled:opacity-50"
                                onClick={() => setConfirming(true)}
                                data-testid="release-run-abandon"
                            >
                                {t("mc.releaseRun.abandonRelease")}
                            </button>
                        )}
                    </div>
                ) : null}
                {abandonError ? (
                    <p className="mt-2 text-right text-12 text-danger" role="alert">
                        {abandonError}
                    </p>
                ) : null}
            </section>
        </PendingLockContext.Provider>
    );
}

// The release followed, in the Project tab: its facts, the actions that move it forward under the trust rule, and its
// end, by itself once all five phases are done or when the user abandons it.
export function ReleaseRunSection({
    dir,
    repo,
    projectName,
    pipeline,
    runs,
    session,
    onEnded,
}: {
    dir: string;
    // The project on GitHub, owner/name: the failed runs an agent reads (#945).
    repo?: string;
    projectName: string;
    pipeline: PipelineDef;
    runs: RunRecord[];
    session: ReleaseSession;
    onEnded: () => void;
}) {
    const lastStep = latestRun(runs, "release");
    const { facts, reload } = useReleaseFacts(dir, `${lastStep?.id}:${lastStep?.state}:${session?.tag ?? ""}`);
    const [pending, setPending] = useState<{ action: PhaseAction; info: UntrustedInfo }>(null);
    const [error, setError] = useState<string>(null);
    const steps = facts?.channel === "public" ? pipeline?.release?.public : pipeline?.release?.rc;
    const locale = useLocale();
    const lock = usePendingLock(facts);
    const run = useMemo(() => releaseRun(facts, steps ?? []), [facts, steps, locale]);
    const tag = run?.tag;
    const trunk = facts?.trunk;
    const actions = useMemo<ReleasePanelActions>(
        () => ({
            run: async (action, onUnproved) => {
                if (action.kind === "rerun") {
                    await releaseRerunFailed(dir, tag);
                    reload();
                    return true;
                }
                if (action.kind === "dispatch") {
                    await releaseDispatchWorkflow(dir, tag, action.workflow);
                    reload();
                    return true;
                }
                const step = action.kind === "prepare" ? PreparationStep : action.step;
                const force = action.kind === "step" && action.force;
                logReleaseAction(`step ${step} of ${tag}: sent${force ? ", confirmed although its check failed" : ""}`);
                let result: Awaited<ReturnType<typeof releaseRunStep>>;
                try {
                    result = await releaseRunStep(dir, tag, step, force);
                } catch (e) {
                    logReleaseAction(`step ${step} of ${tag}: refused, ${serverErrorText(e)}`);
                    throw e;
                }
                if (result?.unproved) {
                    const u = result.unproved;
                    logReleaseAction(
                        `step ${step} of ${tag}: not recorded, ${u.path} ${u.missing ? "is missing" : `lacks "${u.contains}"`} in ${u.dir}`
                    );
                    onUnproved?.(u);
                    return false;
                }
                if (result?.untrusted) {
                    logReleaseAction(`step ${step} of ${tag}: waits for the commands' trust`);
                    setPending({ action, info: result.untrusted });
                    return false;
                }
                logReleaseAction(
                    `step ${step} of ${tag}: run ${result?.run?.id ?? "none"} ${result?.run?.state ?? ""}`
                );
                reload();
                return true;
            },
            loadNotes: async () => (await releaseNotes(dir, tag))?.text ?? "",
            saveNotes: (text) => releaseNotesSave(dir, tag, text),
            rerunRuns: async (failed) => {
                for (const r of failed) {
                    await githubRunRerun(dir, r.runid, true);
                }
                reload();
            },
            resolve: async (phase, mode) => {
                const failure = phase.failure;
                let log = (phase.log?.tail ?? []).join("\n");
                if (failure.runid) {
                    try {
                        log = (await missionLog(dir, failure.runid, 0))?.text ?? log;
                    } catch {
                        // The step's last lines are enough for the agent to start from.
                    }
                }
                const tab = t("mc.releaseRun.resolve.tab", { tag });
                const result = await askReleaseResolve({
                    dir,
                    repo: repo || undefined,
                    tag,
                    phase: phase.id,
                    step: failure.step,
                    trunk: trunk || "main",
                    log,
                    runs: failure.runs.map((r) => ({ name: r.name, url: r.url, runid: r.runid })),
                    mode,
                    workspaceid: globalStore.get(atoms.workspace)?.oid,
                    tabname: tab,
                });
                showStartedAgent(mode, result);
                return { result, tab };
            },
        }),
        [dir, tag, reload, repo, trunk]
    );
    const complete = run != null && !run.active;
    useEffect(() => {
        if (!complete || facts?.session == null) {
            return;
        }
        fireAndForget(async () => {
            await releaseEnd(dir);
            onEnded();
        });
    }, [complete, facts?.session?.tag]);
    if (run == null || !run.active) {
        return null;
    }
    const abandon = async () => {
        await releaseEnd(dir, run.tag);
        onEnded();
        reload();
    };
    const trustAndRun = () =>
        fireAndForget(async () => {
            const next = pending;
            setError(null);
            try {
                await lock.run("trust", async () => {
                    await missionTrust(dir, next.info.hash);
                    const started = await actions.run(next.action);
                    setPending((p) => (p === next ? null : p));
                    return started;
                });
            } catch (e) {
                setPending(null);
                setError(serverErrorText(e));
            }
        });
    return (
        <>
            <ReleaseRunPanel
                run={run}
                jobs={facts?.jobs ?? []}
                actions={actions}
                onAbandon={abandon}
                awaits={facts?.awaits}
                lock={lock}
            />
            {error ? (
                <p className="text-12 text-danger" role="alert">
                    {error}
                </p>
            ) : null}
            {pending != null ? (
                <TrustPrompt
                    projectName={projectName}
                    dir={dir}
                    info={pending.info}
                    onTrust={trustAndRun}
                    onCancel={() => setPending(null)}
                    busy={lock.pending === "trust"}
                />
            ) : null}
        </>
    );
}
