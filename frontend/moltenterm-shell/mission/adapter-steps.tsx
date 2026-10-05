// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A project's adapter steps (FR-MC-018): the project-specific actions its pipeline declares under `steps`, each shown in
// the section it names, run through the trust rule, with its last run's state and last lines.

import { cn, fireAndForget } from "@/util/util";
import { useState } from "react";
import { MoltenWave } from "../molten-button";
import { timeAgo } from "./branch-tree";
import { BlockHeader } from "./cicd-panels";
import { missionCancel } from "./mission-client";
import { logTail, PipelineDef, RunLogMode, runLogVisible, RunRecord } from "./mission-model";
import { RunStateBadge, useRunLog, useStartRun } from "./runs-view";

// must match PipelineSections in pkg/molten/pipeline.go
export type PipelineSection = "timeline" | "cilocal" | "ciremote" | "cd";

const PlainButton =
    "cursor-pointer rounded border border-border px-2 py-1 text-xs text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

function LastLines({ run, full }: { run: RunRecord; full: boolean }) {
    const log = useRunLog(run);
    const lines = logTail(log, full ? 2000 : 6);
    if (lines.length === 0) {
        return null;
    }
    return (
        <pre
            className={cn(
                "mt-2 overflow-auto rounded-md border border-border bg-black/30 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-secondary",
                full ? "max-h-[50vh]" : "max-h-32"
            )}
        >
            {lines.join("\n")}
        </pre>
    );
}

function lastRun(runs: RunRecord[], stepId: string): RunRecord {
    return (runs ?? []).find((r) => r.kind === "step" && r.stepid === stepId) ?? null;
}

function StepRow({
    step,
    last,
    busy,
    onRun,
}: {
    step: { id: string; title: string };
    last: RunRecord;
    busy: boolean;
    onRun: () => void;
}) {
    const [logMode, setLogMode] = useState<RunLogMode>("auto");
    const running = last?.state === "running";
    const full = logMode === "full";
    const showLog = runLogVisible(last, logMode);
    return (
        <div className="border-b border-border px-3 py-2 last:border-b-0" data-testid={`adapter-step-${step.id}`}>
            <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-primary">{step.title}</span>
                {last ? (
                    <>
                        <RunStateBadge state={last.state} />
                        <span className="text-xs text-muted">{timeAgo(new Date(last.startedat).toISOString())}</span>
                        <button
                            type="button"
                            className={PlainButton}
                            onClick={() => setLogMode(full ? "hidden" : "full")}
                        >
                            {full ? "Less" : "Log"}
                        </button>
                        {showLog && !full ? (
                            <button type="button" className={PlainButton} onClick={() => setLogMode("hidden")}>
                                Hide
                            </button>
                        ) : null}
                    </>
                ) : null}
                {running ? (
                    <button
                        type="button"
                        className={PlainButton}
                        onClick={() => fireAndForget(() => missionCancel(last.dir, last.id))}
                    >
                        Cancel
                    </button>
                ) : (
                    <button
                        type="button"
                        disabled={busy}
                        onClick={onRun}
                        className="molten-btn cursor-pointer rounded px-2 py-1 text-xs disabled:cursor-default disabled:opacity-50"
                    >
                        Run
                        <MoltenWave />
                    </button>
                )}
            </div>
            {showLog ? <LastLines run={last} full={full} /> : null}
        </div>
    );
}

export function AdapterSteps({
    dir,
    projectName,
    pipeline,
    runs,
    section,
    bare,
}: {
    dir: string;
    projectName: string;
    pipeline: PipelineDef;
    runs: RunRecord[];
    section: PipelineSection;
    // Inside a card that already frames and titles it (the Project overview's Project steps card).
    bare?: boolean;
}) {
    const { start, prompt, error, clearError } = useStartRun(dir, projectName);
    const steps = (pipeline?.steps ?? []).filter((s) => s.section === section);
    if (steps.length === 0) {
        return null;
    }
    const anyRunning = (runs ?? []).some((r) => r.kind === "step" && r.state === "running");
    return (
        <section className="flex flex-col gap-2">
            {bare ? null : <BlockHeader title="Project steps" hint="declared by the project's pipeline" />}
            <div className={cn("overflow-hidden", !bare && "rounded border border-border")}>
                {steps.map((step) => (
                    <StepRow
                        key={`${step.id}:${lastRun(runs, step.id)?.id ?? ""}`}
                        step={step}
                        last={lastRun(runs, step.id)}
                        busy={anyRunning}
                        onRun={() => start("step", step.id)}
                    />
                ))}
            </div>
            {error ? (
                <button type="button" onClick={clearError} className="cursor-pointer text-left text-xs text-error">
                    {error}
                </button>
            ) : null}
            {prompt}
        </section>
    );
}
