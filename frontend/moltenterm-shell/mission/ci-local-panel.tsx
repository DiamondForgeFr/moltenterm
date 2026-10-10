// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The CI local tab (FR-MC-011), as Notulia's: pick a branch (marked by what the CI says about it now, the Now card's
// rule), run what is not green yet or everything again, follow the runs and each job's live log.

import { openLink } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useMemo, useRef, useState } from "react";
import { MoltenWave } from "../molten-button";
import { LocalCiIcon } from "./ci-icon";
import {
    branchCi,
    branchMark,
    CiJobRecord,
    CiPrepareJob,
    ciRunDuration,
    CiRunRecord,
    CiStatus,
    defaultCiJob,
    formatCiDuration,
    parseAnsi,
    shortSha,
} from "./ci-model";
import { ActionRowClass, RerunConfirm, RowAction, RowActions } from "./ci-row-actions";
import { BlockHeader, Notice, Problem } from "./cicd-panels";
import { ciCancel, ciLog, ciRun, missionTrust, useCiState } from "./mission-client";
import { UntrustedInfo } from "./mission-model";
import { TrustPrompt } from "./runs-view";

const LogPollMs = 1500;
const MaxLogChars = 512 * 1024;

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

function StatusIcon({ status }: { status: CiStatus }) {
    return <LocalCiIcon status={status} />;
}

function formatRunDate(ms: number): string {
    return new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

// A job's log, read from where the last read stopped, every 1.5 s while the job runs.
function useCiLog(dir: string, run: CiRunRecord, job: string, running: boolean): string {
    const [text, setText] = useState("");
    const offset = useRef(0);
    useEffect(() => {
        setText("");
        offset.current = 0;
    }, [run?.id, job]);
    useEffect(() => {
        if (run == null || job == null) {
            return;
        }
        let cancelled = false;
        const read = () =>
            fireAndForget(async () => {
                const chunk = await ciLog(dir, run.id, job, offset.current);
                if (cancelled || chunk == null || chunk.size === offset.current) {
                    return;
                }
                offset.current = chunk.size;
                setText((current) => (current + chunk.text).slice(-MaxLogChars));
            });
        read();
        if (!running) {
            return () => {
                cancelled = true;
            };
        }
        const timer = setInterval(read, LogPollMs);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [dir, run?.id, job, running]);
    return text;
}

function LogPane({ text, paneRef }: { text: string; paneRef: React.RefObject<HTMLPreElement> }) {
    const ref = paneRef;
    const atBottom = useRef(true);
    const segments = useMemo(() => parseAnsi(text), [text]);
    useEffect(() => {
        const el = ref.current;
        if (el && atBottom.current) {
            el.scrollTop = el.scrollHeight;
        }
    }, [text]);
    return (
        <pre
            ref={ref}
            tabIndex={0}
            aria-label="Job log"
            onScroll={(e) => {
                const el = e.currentTarget;
                atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
            className="max-h-[50vh] min-h-32 overflow-auto rounded-4 bg-black/50 p-2 font-mono text-11 leading-snug whitespace-pre-wrap text-[#e5e7eb]"
        >
            {text === ""
                ? "(no output yet)"
                : segments.map((s, i) => (
                      <span
                          key={i}
                          style={{
                              color: s.color,
                              fontWeight: s.bold ? 600 : undefined,
                              opacity: s.dim ? 0.7 : undefined,
                          }}
                      >
                          {s.text}
                      </span>
                  ))}
        </pre>
    );
}

function JobChip({
    job,
    selected,
    now,
    onSelect,
}: {
    job: CiJobRecord;
    selected: boolean;
    now: number;
    onSelect: () => void;
}) {
    const duration = job.startedat ? formatCiDuration((job.finishedat || now) - job.startedat) : "";
    return (
        <button
            type="button"
            onClick={onSelect}
            className={cn(
                "flex cursor-pointer items-center gap-1.5 rounded-6 border px-2 py-1 text-12",
                selected ? "border-accent text-primary" : "border-border text-secondary hover:bg-hover"
            )}
        >
            <StatusIcon status={job.status} />
            {job.title || job.name}
            {duration ? <span className="text-muted">{duration}</span> : null}
        </button>
    );
}

function RunDetail({
    dir,
    run,
    now,
    logRef,
}: {
    dir: string;
    run: CiRunRecord;
    now: number;
    logRef: React.RefObject<HTMLPreElement>;
}) {
    const [picked, setPicked] = useState<string>(null);
    useEffect(() => setPicked(null), [run.id]);
    const job = defaultCiJob(run, picked);
    const jobRecord = run.jobs.find((j) => j.name === job);
    const running = job === CiPrepareJob ? run.status === "running" : jobRecord?.status === "running";
    const log = useCiLog(dir, run, job, running);
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <div>
                <div className="text-13 leading-5 font-medium">
                    {run.branch || "no branch"} @ {shortSha(run.sha)}
                </div>
                <div className="text-11 text-muted">
                    {formatRunDate(run.startedat)} · {formatCiDuration(ciRunDuration(run, now))} · tree{" "}
                    {shortSha(run.tree)} · {run.id}
                </div>
            </div>
            {run.error ? <Problem text={run.error} /> : null}
            <div className="flex flex-wrap gap-1.5">
                <button
                    type="button"
                    onClick={() => setPicked(CiPrepareJob)}
                    className={cn(
                        "cursor-pointer rounded-6 border px-2 py-1 text-12",
                        job === CiPrepareJob ? "border-accent text-primary" : "border-border text-muted hover:bg-hover"
                    )}
                >
                    Prepare
                </button>
                {run.jobs.map((j) => (
                    <JobChip
                        key={j.name}
                        job={j}
                        selected={j.name === job}
                        now={now}
                        onSelect={() => setPicked(j.name)}
                    />
                ))}
            </div>
            <LogPane text={log} paneRef={logRef} />
        </div>
    );
}

// A local run's row (FR-SHELL-057): a click selects it; Logs, Rerun (after a question, on the run's branch, only what is
// not green yet) and GitHub (its commit) on hover and focus.
function RunRow({
    run,
    selected,
    now,
    github,
    canRerun,
    onSelect,
    onLogs,
    onRerun,
}: {
    run: CiRunRecord;
    selected: boolean;
    now: number;
    github: string;
    canRerun: boolean;
    onSelect: () => void;
    onLogs: () => void;
    onRerun: () => Promise<void>;
}) {
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const rerunRef = useRef<HTMLButtonElement>(null);
    const jobs = run.only?.length ? run.only.join(", ") : run.jobs.map((j) => j.name).join(", ");
    const branch = run.branch || "no branch";
    const commit = github && run.sha ? `${github}/commit/${run.sha}` : null;
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
                await onRerun();
                setConfirming(false);
            } catch (e) {
                setError(String(e?.message ?? e));
            } finally {
                setBusy(false);
            }
        });
    return (
        <div className={cn(ActionRowClass, selected && "bg-hover")} data-testid="ci-local-row" data-state={run.status}>
            <div className="flex items-center gap-1 pr-2">
                <button
                    type="button"
                    onClick={onSelect}
                    aria-current={selected || undefined}
                    className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 py-2 pl-3 text-left outline-offset-[-2px]"
                >
                    <span className="flex h-5 items-center">
                        <StatusIcon status={run.status} />
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                            <span className="truncate text-13 leading-5">{branch}</span>
                            <span className="shrink-0 text-11 text-muted">
                                {formatCiDuration(ciRunDuration(run, now))}
                            </span>
                        </span>
                        <span className="block truncate text-11 text-muted">
                            {shortSha(run.sha)} · {formatRunDate(run.startedat)} · {jobs}
                        </span>
                    </span>
                </button>
                <RowActions label={`Local CI run on ${branch}`}>
                    <RowAction icon="fa-solid fa-file-lines" label="Logs" onClick={onLogs} testId="ci-row-logs" />
                    <RowAction
                        buttonRef={rerunRef}
                        icon="fa-solid fa-rotate-right"
                        label={canRerun ? "Rerun" : "Rerun (once the run under way ends)"}
                        disabled={!canRerun || !run.branch}
                        onClick={() => setConfirming(true)}
                        testId="ci-row-rerun"
                    />
                    <RowAction
                        icon="fa-brands fa-github"
                        label={commit ? "Open the commit on GitHub" : "Not on GitHub"}
                        disabled={commit == null}
                        onClick={() => commit && fireAndForget(() => openLink(commit))}
                        testId="ci-row-github"
                    />
                </RowActions>
            </div>
            {confirming ? (
                <RerunConfirm
                    question={`Run the local CI on ${branch} again? Only what is not green yet runs.`}
                    confirmLabel="Rerun"
                    busy={busy}
                    error={error}
                    onConfirm={rerun}
                    onCancel={closeConfirm}
                />
            ) : null}
        </div>
    );
}

export function LocalCiRunner({ dir, projectName, github }: { dir: string; projectName: string; github?: string }) {
    const { state, reload } = useCiState(dir);
    const [branch, setBranch] = useState<string>(null);
    const [force, setForce] = useState(false);
    const [selected, setSelected] = useState<string>(null);
    const [error, setError] = useState<string>(null);
    const [busy, setBusy] = useState(false);
    const [untrusted, setUntrusted] = useState<{ info: UntrustedInfo; branch: string; force: boolean }>(null);
    const [now, setNow] = useState(Date.now());
    const logRef = useRef<HTMLPreElement>(null);
    const running = state?.running ? state.runs.find((r) => r.id === state.running) : null;
    useEffect(() => {
        if (!running) {
            return;
        }
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [running?.id]);
    useEffect(() => {
        if (branch == null && state?.current) {
            setBranch(state.current);
        }
    }, [state?.current]);
    if (state == null) {
        return <Notice text="Reading the local CI…" />;
    }
    const shown = state.runs.find((r) => r.id === selected) ?? running ?? state.runs[0];
    // A run the project's commands are not trusted for yet opens the trust prompt, which starts it once trusted.
    const launch = async (onBranch: string, forceRun: boolean) => {
        const result = await ciRun(dir, onBranch, forceRun);
        if (result?.untrusted) {
            setUntrusted({ info: result.untrusted, branch: onBranch, force: forceRun });
            return;
        }
        if (result?.run) {
            setSelected(result.run.id);
        }
    };
    const startOn = (onBranch: string, forceRun: boolean) =>
        fireAndForget(async () => {
            setBusy(true);
            setError(null);
            try {
                await launch(onBranch, forceRun);
            } catch (e) {
                setError(String(e?.message ?? e));
            } finally {
                setBusy(false);
            }
        });
    const start = () => startOn(branch ?? "", force);
    const trustAndRun = () =>
        fireAndForget(async () => {
            const pending = untrusted;
            setUntrusted(null);
            try {
                await missionTrust(dir, pending.info.hash);
                startOn(pending.branch, pending.force);
            } catch (e) {
                setError(String(e?.message ?? e));
            }
        });
    const showLogs = (id: string) => {
        setSelected(id);
        requestAnimationFrame(() => {
            logRef.current?.scrollIntoView({ block: "nearest" });
            logRef.current?.focus({ preventScroll: true });
        });
    };
    const branches = state.branches ?? [];
    return (
        <section className="flex flex-col gap-2">
            <BlockHeader
                title="Local CI"
                hint="molten ci run · verdicts kept per code, only what is not green reruns"
            />
            <div className="flex flex-wrap items-center gap-2">
                <select
                    value={branch ?? ""}
                    onChange={(e) => setBranch(e.target.value)}
                    aria-label="Branch"
                    className="max-w-[260px] cursor-pointer rounded-6 border border-border bg-transparent px-1.5 py-1 text-12 text-secondary"
                >
                    {branches.length === 0 ? <option value="">HEAD</option> : null}
                    {branches.map((b) => (
                        <option key={b.name} value={b.name} className="bg-surface-3">
                            {b.name}
                            {branchMark(branchCi(state, b.name).status)}
                        </option>
                    ))}
                </select>
                <label className="flex cursor-pointer items-center gap-1.5 text-12 text-secondary">
                    <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                    Run all again
                </label>
                <button
                    type="button"
                    disabled={busy || running != null}
                    onClick={start}
                    className="molten-btn cursor-pointer rounded-6 px-3 py-1 text-12 disabled:cursor-default disabled:opacity-60"
                >
                    {running != null ? (
                        <>
                            <i className="fa fa-solid fa-circle-notch fa-spin mt-step-spin mr-1 text-11" />
                            Running…
                        </>
                    ) : (
                        "Run"
                    )}
                    <MoltenWave />
                </button>
                {running != null ? (
                    <button
                        type="button"
                        onClick={() =>
                            fireAndForget(async () => {
                                await ciCancel(dir, running.id);
                                reload();
                            })
                        }
                        className={PlainButton}
                    >
                        Cancel
                    </button>
                ) : null}
            </div>
            {error ? <Problem text={error} /> : null}
            {state.runs.length === 0 ? (
                <Notice text="No run yet: start one above, or run molten ci run in a terminal of the project." />
            ) : (
                <div className="grid min-w-0 gap-3 @2xl:grid-cols-[320px_minmax(0,1fr)]">
                    <div className="max-h-[60vh] overflow-y-auto rounded-4 border border-border">
                        {state.runs.map((r) => (
                            <RunRow
                                key={r.id}
                                run={r}
                                selected={r.id === shown?.id}
                                now={now}
                                github={github}
                                canRerun={running == null && !busy}
                                onSelect={() => setSelected(r.id)}
                                onLogs={() => showLogs(r.id)}
                                onRerun={() => launch(r.branch, false)}
                            />
                        ))}
                    </div>
                    {shown ? <RunDetail dir={dir} run={shown} now={now} logRef={logRef} /> : null}
                </div>
            )}
            {untrusted != null ? (
                <TrustPrompt
                    projectName={projectName}
                    dir={dir}
                    info={untrusted.info}
                    onTrust={trustAndRun}
                    onCancel={() => setUntrusted(null)}
                />
            ) : null}
        </section>
    );
}
