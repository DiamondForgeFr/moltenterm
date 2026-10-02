// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Starting and following a project's declared builds (FR-MC-006, DS-MC-005): the trust prompt the first run of a
// project's commands asks for, the card of a build (phases, last lines of its log, the whole log on demand, cancel,
// open or show its artifact), and the list of recent builds.

import { getApi } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pathParent } from "../workspace-project";
import { timeAgo } from "./branch-tree";
import { missionCancel, missionLog, missionRun, missionTrust } from "./mission-client";
import { formatElapsed, logTail, RunRecord, RunState, RunStateLabels, UntrustedInfo } from "./mission-model";

const StateClasses: Record<RunState, string> = {
    running: "bg-accent/20 text-accent",
    success: "bg-success/20 text-success",
    failure: "bg-error/20 text-error",
    cancelled: "bg-hover text-muted",
    lost: "bg-warning/20 text-warning",
};

const PlainButton =
    "cursor-pointer rounded border border-border px-2 py-1 text-xs text-secondary hover:bg-hover hover:text-primary";

function TrustPrompt({
    projectName,
    dir,
    info,
    onTrust,
    onCancel,
}: {
    projectName: string;
    dir: string;
    info: UntrustedInfo;
    onTrust: () => void;
    onCancel: () => void;
}) {
    return createPortal(
        <div className="fixed inset-0 z-[9600] flex items-center justify-center bg-black/40" onPointerDown={onCancel}>
            <div
                onPointerDown={(e) => e.stopPropagation()}
                className="flex max-h-[80vh] w-[560px] flex-col rounded border border-border bg-modalbg shadow-xl"
            >
                <div className="border-b border-border px-4 py-3">
                    <div className="text-sm font-semibold">Run {projectName}'s commands?</div>
                    <div className="mt-0.5 text-xs text-muted">
                        MoltenTerm runs them in {dir}, with your rights. It asks again whenever they change.
                    </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto px-4 py-2">
                    {info.commands.map((c) => (
                        <div key={`${c.kind}:${c.id}`} className="border-b border-border py-1.5 last:border-b-0">
                            <div className="text-xs">
                                <span className="mr-1.5 rounded bg-hover px-1 text-[10px] text-muted uppercase">
                                    {c.kind}
                                </span>
                                {c.title || c.id}
                            </div>
                            <code className="block text-[11px] break-all text-secondary">
                                {c.cwd ? `${c.cwd}$ ` : ""}
                                {c.run}
                            </code>
                        </div>
                    ))}
                </div>
                <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
                    <button type="button" onClick={onCancel} className={PlainButton}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onTrust}
                        className="cursor-pointer rounded bg-accent/80 px-3 py-1 text-xs text-primary transition-colors hover:bg-accent"
                    >
                        Trust and run
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}

type PendingRun = { kind: string; id: string; info: UntrustedInfo };

// Starts a declared command; the first time (or after a change) the user reviews and trusts the project's commands.
export function useStartRun(dir: string, projectName: string) {
    const [pending, setPending] = useState<PendingRun>(null);
    const [error, setError] = useState<string>(null);
    const start = (kind: string, id: string) =>
        fireAndForget(async () => {
            setError(null);
            try {
                const result = await missionRun(dir, kind, id);
                if (result?.untrusted) {
                    setPending({ kind, id, info: result.untrusted });
                }
            } catch (e) {
                setError(String(e?.message ?? e));
            }
        });
    const trustAndRun = () =>
        fireAndForget(async () => {
            const run = pending;
            setPending(null);
            try {
                await missionTrust(dir, run.info.hash);
                await missionRun(dir, run.kind, run.id);
            } catch (e) {
                setError(String(e?.message ?? e));
            }
        });
    const prompt =
        pending != null ? (
            <TrustPrompt
                projectName={projectName}
                dir={dir}
                info={pending.info}
                onTrust={trustAndRun}
                onCancel={() => setPending(null)}
            />
        ) : null;
    return { start, prompt, error, clearError: () => setError(null) };
}

function openPath(path: string) {
    getApi().openNativePath(path);
}

// The artifact a build produced: opened (an app starts), or shown in the Finder through its folder.
export function ArtifactActions({ run }: { run: RunRecord }) {
    if (!run.artifact || run.state !== "success") {
        return null;
    }
    return (
        <>
            <button type="button" onClick={() => openPath(run.artifact)} className={PlainButton} title={run.artifact}>
                <i className="fa fa-solid fa-play mr-1 text-[9px]" />
                Open
            </button>
            <button type="button" onClick={() => openPath(pathParent(run.artifact))} className={PlainButton}>
                <i className="fa fa-solid fa-folder-open mr-1 text-[10px]" />
                Show in Finder
            </button>
        </>
    );
}

// The log of a run, read from where the last read stopped, every second while the run goes on.
function useRunLog(run: RunRecord): string {
    const [text, setText] = useState("");
    const offset = useRef(0);
    useEffect(() => {
        setText("");
        offset.current = 0;
    }, [run.id]);
    useEffect(() => {
        let cancelled = false;
        const read = () =>
            fireAndForget(async () => {
                const chunk = await missionLog(run.dir, run.id, offset.current);
                if (cancelled || chunk == null || chunk.size === offset.current) {
                    return;
                }
                offset.current = chunk.size;
                setText((current) => (current + chunk.text).slice(-512 * 1024));
            });
        read();
        if (run.state !== "running") {
            return () => {
                cancelled = true;
            };
        }
        const timer = setInterval(read, 1000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [run.id, run.state, run.logsize]);
    return text;
}

export function RunStateBadge({ state }: { state: RunState }) {
    return (
        <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", StateClasses[state])}>
            {state === "running" ? <i className="fa fa-solid fa-circle-notch fa-spin mr-1 text-[9px]" /> : null}
            {RunStateLabels[state] ?? state}
        </span>
    );
}

export function BuildRunCard({ run }: { run: RunRecord }) {
    const log = useRunLog(run);
    const [full, setFull] = useState(false);
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (run.state !== "running") {
            return;
        }
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [run.state]);
    const elapsed = (run.finishedat || now) - run.startedat;
    const lines = logTail(log, full ? 2000 : 8);
    return (
        <section className="rounded border border-accent/40 bg-accent/5 p-3" data-testid="build-run">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
                <i className="fa fa-solid fa-hammer text-accent" /> Build local
            </div>
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 text-sm font-medium text-primary" title={run.command}>
                    {run.title}
                </div>
                <RunStateBadge state={run.state} />
            </div>
            <div className="mt-0.5 text-[11px] text-muted">
                {formatElapsed(elapsed)}
                {run.state !== "running" ? ` · ${timeAgo(new Date(run.startedat).toISOString())}` : ""}
                {run.exit != null && run.state === "failure" ? ` · exit ${run.exit}` : ""}
            </div>
            {run.phases.length > 0 ? (
                <div className="mt-2 flex flex-wrap items-center gap-1">
                    {run.phases.map((phase, i) => {
                        const current = run.state === "running" && i === run.phases.length - 1;
                        return (
                            <span
                                key={`${phase}-${i}`}
                                className={cn(
                                    "rounded border px-1.5 py-0.5 text-[11px]",
                                    current ? "border-accent text-accent" : "border-border text-secondary"
                                )}
                            >
                                {current ? <i className="fa fa-solid fa-circle-notch fa-spin mr-1 text-[9px]" /> : null}
                                {phase}
                            </span>
                        );
                    })}
                </div>
            ) : null}
            {lines.length > 0 ? (
                <pre
                    className={cn(
                        "mt-2 overflow-auto rounded bg-black/30 p-2 font-mono text-[10.5px] leading-snug whitespace-pre-wrap text-secondary",
                        full ? "max-h-[50vh]" : "max-h-40"
                    )}
                >
                    {lines.join("\n")}
                </pre>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {run.state === "running" ? (
                    <button
                        type="button"
                        onClick={() => fireAndForget(() => missionCancel(run.dir, run.id))}
                        className={PlainButton}
                    >
                        Cancel
                    </button>
                ) : null}
                <ArtifactActions run={run} />
                <button type="button" onClick={() => setFull(!full)} className={PlainButton}>
                    {full ? "Less" : "Whole log"}
                </button>
            </div>
        </section>
    );
}

export function RecentBuilds({ runs }: { runs: RunRecord[] }) {
    const builds = (runs ?? []).filter((r) => r.kind === "build").slice(0, 10);
    if (builds.length === 0) {
        return <p className="p-3 text-sm text-muted">No local build yet: start one from Timeline › Build local.</p>;
    }
    return (
        <>
            {builds.map((run) => (
                <div key={run.id} className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0">
                    <RunStateBadge state={run.state} />
                    <span className="min-w-0 flex-1 truncate text-sm text-primary" title={run.command}>
                        {run.title}
                    </span>
                    <span className="text-xs text-muted">{timeAgo(new Date(run.startedat).toISOString())}</span>
                    <ArtifactActions run={run} />
                </div>
            ))}
        </>
    );
}
