// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The release in flight (FR-MC-016), as Notulia's ReleaseRunPanel: five phases, where it is, what it waits on, and why
// it is stuck when it is. Each phase has at most one button, the next thing to do there; the cut says what cannot be
// taken back before it lands, and while it waits its public notes are read and edited here.

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useMemo, useState } from "react";
import {
    missionTrust,
    releaseEnd,
    releaseNotes,
    releaseNotesSave,
    releaseRerunFailed,
    releaseRunStep,
    useReleaseFacts,
} from "./mission-client";
import { latestRun, PipelineDef, ReleasePhase, RunRecord, UntrustedInfo } from "./mission-model";
import { ReleaseSession } from "./release-model";
import { Phase, PhaseAction, PhaseStatus, ReleaseGhJob, ReleaseRun, releaseRun } from "./release-run";
import { TrustPrompt } from "./runs-view";

const NodeClasses: Record<PhaseStatus, string> = {
    done: "border-emerald-500/60 bg-emerald-500/10 text-emerald-400",
    running: "border-accent/70 bg-accent/15 text-accent",
    waiting: "border-amber-500/60 bg-amber-500/10 text-amber-400",
    failed: "border-error/60 bg-error/10 text-error",
    todo: "border-border bg-transparent text-muted",
};

const Says: Record<PhaseStatus, string> = {
    done: "done",
    running: "running",
    waiting: "your turn",
    failed: "failed",
    todo: "to come",
};

const ShortTitles: Record<ReleasePhase, string> = {
    prepare: "Prepare",
    cut: "Cut",
    build: "Build",
    publish: "Publish",
    back: "Back",
};

const PlainButton =
    "cursor-pointer rounded border border-border px-2 py-1 text-xs text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";
const AccentButton =
    "cursor-pointer rounded bg-accent/80 px-3 py-1 text-xs text-primary transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-50";

export type ReleasePanelActions = {
    run: (action: PhaseAction) => Promise<void>;
    loadNotes: () => Promise<string>;
    saveNotes: (text: string) => Promise<void>;
};

function StatusIcon({ status }: { status: PhaseStatus }) {
    switch (status) {
        case "done":
            return <i className="fa fa-solid fa-check text-[11px]" />;
        case "running":
            return <i className="fa fa-solid fa-circle-notch fa-spin text-[11px]" />;
        case "waiting":
            return <i className="fa fa-solid fa-hand text-[11px]" />;
        case "failed":
            return <i className="fa fa-solid fa-xmark text-[11px]" />;
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
    useEffect(() => {
        if (!running) {
            return;
        }
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [running]);
    return (
        <ul className="mt-3 flex flex-col gap-1">
            {jobs.map((job) => {
                const status = jobStatus(job);
                return (
                    <li key={job.name} className="flex items-center gap-2 text-xs">
                        <span
                            className={cn(
                                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[8px]",
                                NodeClasses[status]
                            )}
                        >
                            <StatusIcon status={status} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-secondary">{job.name}</span>
                        <span className="text-muted tabular-nums">{jobDuration(job, now)}</span>
                    </li>
                );
            })}
        </ul>
    );
}

function ActionButton({ action, actions }: { action: PhaseAction; actions: ReleasePanelActions }) {
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const confirm = action.kind === "step" ? action.confirm : null;
    const go = () =>
        fireAndForget(async () => {
            setBusy(true);
            setError(null);
            try {
                await actions.run(action);
                setConfirming(false);
            } catch (e) {
                setError(String(e?.message ?? e));
            } finally {
                setBusy(false);
            }
        });
    return (
        <div className="mt-3 flex flex-col gap-2">
            {confirming && confirm ? (
                <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-300">
                    {confirm}
                </p>
            ) : null}
            <div className="flex justify-end gap-2">
                {confirming ? (
                    <button type="button" className={PlainButton} onClick={() => setConfirming(false)}>
                        Cancel
                    </button>
                ) : null}
                <button
                    type="button"
                    disabled={busy}
                    className={AccentButton}
                    onClick={() => (confirm && !confirming ? setConfirming(true) : go())}
                >
                    {busy ? <i className="fa fa-solid fa-circle-notch fa-spin mr-1.5 text-[10px]" /> : null}
                    {confirming ? "Confirm" : action.label}
                </button>
            </div>
            {error ? <p className="text-right text-xs text-error">{error}</p> : null}
        </div>
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
    const [text, setText] = useState<string>(null);
    const [saved, setSaved] = useState<string>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const load = () =>
        fireAndForget(async () => {
            try {
                const next = await actions.loadNotes();
                setText(next);
                setSaved(next);
            } catch (e) {
                setError(String(e?.message ?? e));
            }
        });
    useEffect(load, [actions]);
    const dirty = text != null && text !== saved;
    useEffect(() => onDirty(dirty), [dirty]);
    if (text == null) {
        return error ? <p className="mt-3 text-xs text-error">{error}</p> : null;
    }
    return (
        <div className="mt-3 flex flex-col gap-2">
            <div className="text-[11px] text-muted">Public notes: what the release page says</div>
            <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="min-h-48 rounded border border-border bg-transparent p-2 font-mono text-xs text-primary"
            />
            <div className="flex justify-end gap-2">
                {rewrite ? (
                    <button
                        type="button"
                        disabled={busy}
                        className={PlainButton}
                        onClick={() =>
                            fireAndForget(async () => {
                                setBusy(true);
                                try {
                                    await actions.run(rewrite);
                                } catch (e) {
                                    setError(String(e?.message ?? e));
                                } finally {
                                    setBusy(false);
                                }
                            })
                        }
                    >
                        Rewrite
                    </button>
                ) : null}
                <button
                    type="button"
                    disabled={!dirty || busy}
                    className={PlainButton}
                    onClick={() =>
                        fireAndForget(async () => {
                            setBusy(true);
                            setError(null);
                            try {
                                await actions.saveNotes(text);
                                setSaved(text);
                            } catch (e) {
                                setError(String(e?.message ?? e));
                            } finally {
                                setBusy(false);
                            }
                        })
                    }
                >
                    Save
                </button>
            </div>
            {error ? <p className="text-right text-xs text-error">{error}</p> : null}
        </div>
    );
}

function Detail({
    run,
    phase,
    jobs,
    actions,
}: {
    run: ReleaseRun;
    phase: Phase;
    jobs: ReleaseGhJob[];
    actions: ReleasePanelActions;
}) {
    const [notesDirty, setNotesDirty] = useState(false);
    const editing = phase.id === "cut" && run.editNotes;
    const rewrite: PhaseAction = run.notesStep
        ? { kind: "step", step: run.notesStep.id, label: run.notesStep.title || run.notesStep.id }
        : null;
    const tail = phase.log?.tail ?? [];
    return (
        <div
            className="mt-4 rounded-lg border border-border bg-black/20 p-3"
            data-testid={`release-run-detail-${phase.id}`}
        >
            <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium text-primary">{phase.title}</h3>
                <span className="text-[11px] text-muted">{Says[phase.status]}</span>
            </div>
            <p className="mt-1 text-xs text-secondary">{phase.expect}</p>
            {phase.cause ? (
                <p className="mt-2 flex items-start gap-1.5 rounded border border-error/40 bg-error/10 px-2 py-1.5 text-xs text-error">
                    <i className="fa fa-solid fa-triangle-exclamation mt-0.5 text-[11px]" />
                    {phase.cause}
                </p>
            ) : null}
            {phase.id === "build" && jobs.length > 0 ? <Jobs jobs={jobs} /> : null}
            {phase.status !== "done" && tail.length > 0 ? (
                <pre className="mt-3 max-h-32 overflow-auto rounded-md border border-border bg-black/30 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-secondary">
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
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex cursor-pointer items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-secondary hover:bg-hover hover:text-primary"
                        >
                            {link.label}
                            <i className="fa fa-solid fa-arrow-up-right-from-square text-[9px]" />
                        </a>
                    ))}
                </div>
            ) : null}
            {phase.action ? (
                editing && notesDirty ? (
                    <p className="mt-3 text-right text-xs text-muted">Save the notes before cutting.</p>
                ) : (
                    <ActionButton key={phase.action.label} action={phase.action} actions={actions} />
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
}: {
    run: ReleaseRun;
    jobs: ReleaseGhJob[];
    actions: ReleasePanelActions;
    // Given when the release was launched from the Timeline: following it can stop.
    onAbandon?: () => void;
}) {
    const [picked, setPicked] = useState<ReleasePhase>(null);
    const [confirming, setConfirming] = useState(false);
    const shown = run.phases.find((p) => p.id === (picked ?? run.current)) ?? run.phases[run.phases.length - 1];
    return (
        <section
            className="rounded-lg border border-accent/40 bg-gradient-to-br from-accent/10 to-transparent p-4"
            data-testid="release-run"
        >
            <div className="mb-3 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
                <i className="fa fa-solid fa-tower-broadcast text-accent" />
                Release in flight
                <span className="ml-auto rounded-full border border-border px-2 py-0.5 font-mono tracking-normal text-primary normal-case">
                    {run.tag} · {run.channel === "rc" ? "internal" : "public"}
                </span>
            </div>
            <ol className="flex items-start gap-1" aria-label="Phases of the release">
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
                                    "text-[11px] whitespace-nowrap",
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
                                    p.status === "done" ? "bg-emerald-500/60" : "bg-border"
                                )}
                                aria-hidden
                            />
                        ) : null}
                    </li>
                ))}
            </ol>
            <Detail run={run} phase={shown} jobs={jobs} actions={actions} />
            {onAbandon ? (
                <div className="mt-3 flex items-center justify-end gap-2 text-[11px]">
                    {confirming ? (
                        <>
                            <span className="text-muted">Stop following {run.tag}? Nothing pushed is undone.</span>
                            <button type="button" className={PlainButton} onClick={() => setConfirming(false)}>
                                No
                            </button>
                            <button
                                type="button"
                                className="cursor-pointer rounded border border-error/50 px-2 py-1 text-xs text-error hover:bg-error/10"
                                onClick={onAbandon}
                            >
                                Abandon
                            </button>
                        </>
                    ) : (
                        <button
                            type="button"
                            className="cursor-pointer rounded px-2 py-1 text-muted hover:text-primary"
                            onClick={() => setConfirming(true)}
                        >
                            Abandon this release
                        </button>
                    )}
                </div>
            ) : null}
        </section>
    );
}

// The release followed, on the Timeline: its facts, the actions that move it forward under the trust rule, and its
// end, by itself once all five phases are done or when the user abandons it.
export function ReleaseRunSection({
    dir,
    projectName,
    pipeline,
    runs,
    session,
    onEnded,
}: {
    dir: string;
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
    const run = useMemo(() => releaseRun(facts, steps ?? []), [facts, steps]);
    const tag = run?.tag;
    const actions = useMemo<ReleasePanelActions>(
        () => ({
            run: async (action) => {
                if (action.kind === "rerun") {
                    await releaseRerunFailed(dir, tag);
                    reload();
                    return;
                }
                const result = await releaseRunStep(dir, tag, action.step);
                if (result?.untrusted) {
                    setPending({ action, info: result.untrusted });
                }
            },
            loadNotes: async () => (await releaseNotes(dir, tag))?.text ?? "",
            saveNotes: (text) => releaseNotesSave(dir, tag, text),
        }),
        [dir, tag, reload]
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
    const abandon = () =>
        fireAndForget(async () => {
            await releaseEnd(dir);
            onEnded();
            reload();
        });
    const trustAndRun = () =>
        fireAndForget(async () => {
            const next = pending;
            setPending(null);
            try {
                await missionTrust(dir, next.info.hash);
                await actions.run(next.action);
            } catch (e) {
                setError(String(e?.message ?? e));
            }
        });
    return (
        <>
            <ReleaseRunPanel
                run={run}
                jobs={facts?.jobs ?? []}
                actions={actions}
                onAbandon={facts?.session ? abandon : undefined}
            />
            {error ? <p className="text-xs text-error">{error}</p> : null}
            {pending != null ? (
                <TrustPrompt
                    projectName={projectName}
                    dir={dir}
                    info={pending.info}
                    onTrust={trustAndRun}
                    onCancel={() => setPending(null)}
                />
            ) : null}
        </>
    );
}
