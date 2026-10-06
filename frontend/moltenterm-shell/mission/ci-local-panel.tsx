// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The CI local tab (FR-MC-011), as Notulia's: pick a branch (marked by what the CI says about it now, the Now card's
// rule), run what is not green yet or everything again, follow the runs and each job's live log.

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useMemo, useRef, useState } from "react";
import { MoltenWave } from "../molten-button";
import {
    branchCi,
    branchMark,
    CiJobRecord,
    CiPrepareJob,
    ciRunDuration,
    CiRunRecord,
    CiStatus,
    CiStatusLabels,
    defaultCiJob,
    formatCiDuration,
    parseAnsi,
    shortSha,
} from "./ci-model";
import { BlockHeader, Notice, Problem } from "./cicd-panels";
import { ciCancel, ciLog, ciRun, missionTrust, useCiState } from "./mission-client";
import { UntrustedInfo } from "./mission-model";
import { TrustPrompt } from "./runs-view";

const LogPollMs = 1500;
const MaxLogChars = 512 * 1024;

const StatusIcons: Record<CiStatus, string> = {
    success: "fa-circle-check text-success",
    failure: "fa-circle-xmark text-error",
    running: "fa-circle-notch fa-spin text-accent",
    interrupted: "fa-triangle-exclamation text-warning",
    queued: "fa-clock text-muted",
    cancelled: "fa-ban text-muted",
};

const PlainButton =
    "cursor-pointer rounded border border-border px-2 py-1 text-xs text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

function StatusIcon({ status }: { status: CiStatus }) {
    return (
        <i
            className={cn("fa fa-solid w-3.5 shrink-0 text-center text-[12px]", StatusIcons[status])}
            aria-label={CiStatusLabels[status]}
            title={CiStatusLabels[status]}
        />
    );
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

function LogPane({ text }: { text: string }) {
    const ref = useRef<HTMLPreElement>(null);
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
            onScroll={(e) => {
                const el = e.currentTarget;
                atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
            className="max-h-[50vh] min-h-32 overflow-auto rounded bg-black/50 p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap text-[#e5e7eb]"
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
                "flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 text-xs",
                selected ? "border-accent text-primary" : "border-border text-secondary hover:bg-hover"
            )}
        >
            <StatusIcon status={job.status} />
            {job.title || job.name}
            {duration ? <span className="text-muted">{duration}</span> : null}
        </button>
    );
}

function RunDetail({ dir, run, now }: { dir: string; run: CiRunRecord; now: number }) {
    const [picked, setPicked] = useState<string>(null);
    useEffect(() => setPicked(null), [run.id]);
    const job = defaultCiJob(run, picked);
    const jobRecord = run.jobs.find((j) => j.name === job);
    const running = job === CiPrepareJob ? run.status === "running" : jobRecord?.status === "running";
    const log = useCiLog(dir, run, job, running);
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <div>
                <div className="text-sm font-medium">
                    {run.branch || "no branch"} @ {shortSha(run.sha)}
                </div>
                <div className="text-[11px] text-muted">
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
                        "cursor-pointer rounded border px-2 py-1 text-xs",
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
            <LogPane text={log} />
        </div>
    );
}

function RunRow({
    run,
    selected,
    now,
    onSelect,
}: {
    run: CiRunRecord;
    selected: boolean;
    now: number;
    onSelect: () => void;
}) {
    const jobs = run.only?.length ? run.only.join(", ") : run.jobs.map((j) => j.name).join(", ");
    return (
        <button
            type="button"
            onClick={onSelect}
            className={cn(
                "flex w-full cursor-pointer items-start gap-2 border-b border-border px-3 py-2 text-left last:border-b-0",
                selected ? "bg-hover" : "hover:bg-hover"
            )}
        >
            <StatusIcon status={run.status} />
            <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm">{run.branch || "no branch"}</span>
                    <span className="shrink-0 text-[11px] text-muted">{formatCiDuration(ciRunDuration(run, now))}</span>
                </div>
                <div className="truncate text-[11px] text-muted">
                    {shortSha(run.sha)} · {formatRunDate(run.startedat)} · {jobs}
                </div>
            </div>
        </button>
    );
}

export function LocalCiRunner({ dir, projectName }: { dir: string; projectName: string }) {
    const { state, reload } = useCiState(dir);
    const [branch, setBranch] = useState<string>(null);
    const [force, setForce] = useState(false);
    const [selected, setSelected] = useState<string>(null);
    const [error, setError] = useState<string>(null);
    const [busy, setBusy] = useState(false);
    const [untrusted, setUntrusted] = useState<UntrustedInfo>(null);
    const [now, setNow] = useState(Date.now());
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
    const start = () =>
        fireAndForget(async () => {
            setBusy(true);
            setError(null);
            try {
                const result = await ciRun(dir, branch ?? "", force);
                if (result?.untrusted) {
                    setUntrusted(result.untrusted);
                    return;
                }
                if (result?.run) {
                    setSelected(result.run.id);
                }
            } catch (e) {
                setError(String(e?.message ?? e));
            } finally {
                setBusy(false);
            }
        });
    const trustAndRun = () =>
        fireAndForget(async () => {
            const info = untrusted;
            setUntrusted(null);
            try {
                await missionTrust(dir, info.hash);
                start();
            } catch (e) {
                setError(String(e?.message ?? e));
            }
        });
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
                    className="max-w-[260px] cursor-pointer rounded border border-border bg-transparent px-1.5 py-1 text-xs text-secondary"
                >
                    {branches.length === 0 ? <option value="">HEAD</option> : null}
                    {branches.map((b) => (
                        <option key={b.name} value={b.name} className="bg-modalbg">
                            {b.name}
                            {branchMark(branchCi(state, b.name).status)}
                        </option>
                    ))}
                </select>
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-secondary">
                    <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                    Run all again
                </label>
                <button
                    type="button"
                    disabled={busy || running != null}
                    onClick={start}
                    className="molten-btn cursor-pointer rounded px-3 py-1 text-xs disabled:cursor-default disabled:opacity-60"
                >
                    {running != null ? (
                        <>
                            <i className="fa fa-solid fa-circle-notch fa-spin mr-1 text-[10px]" />
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
                <div className="grid min-w-0 gap-3 @2xl:grid-cols-[280px_minmax(0,1fr)]">
                    <div className="max-h-[60vh] overflow-y-auto rounded border border-border">
                        {state.runs.map((r) => (
                            <RunRow
                                key={r.id}
                                run={r}
                                selected={r.id === shown?.id}
                                now={now}
                                onSelect={() => setSelected(r.id)}
                            />
                        ))}
                    </div>
                    {shown ? <RunDetail dir={dir} run={shown} now={now} /> : null}
                </div>
            )}
            {untrusted != null ? (
                <TrustPrompt
                    projectName={projectName}
                    dir={dir}
                    info={untrusted}
                    onTrust={trustAndRun}
                    onCancel={() => setUntrusted(null)}
                />
            ) : null}
        </section>
    );
}
