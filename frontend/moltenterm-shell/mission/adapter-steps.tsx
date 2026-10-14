// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A project's adapter steps (FR-MC-018): the project-specific actions its pipeline declares under `steps`, each shown in
// the section it names, run through the trust rule, with its last run's state and last lines.

import { cn, fireAndForget } from "@/util/util";
import { useState } from "react";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { BlockHeader } from "./cicd-panels";
import { useConfirmedDeploy } from "./deploy-menu";
import { deployRevision, deployTarget } from "./deploy-model";
import { missionCancel, missionClose } from "./mission-client";
import { logTail, MissionGit, PipelineDef, RunLogMode, runLogVisible, RunRecord, runStale } from "./mission-model";
import { RunStateBadge, useRunLog, useStartRun } from "./runs-view";
import { timeAgo } from "./time-format";

// must match PipelineSections in pkg/molten/pipeline.go
export type PipelineSection = "timeline" | "cilocal" | "ciremote" | "cd";

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

function LastLines({ run, full }: { run: RunRecord; full: boolean }) {
    const log = useRunLog(run);
    const lines = logTail(log, full ? 2000 : 6);
    if (lines.length === 0) {
        return null;
    }
    return (
        <pre
            className={cn(
                "mt-2 overflow-auto rounded-6 border border-border bg-black/30 px-2 py-1.5 font-mono text-11 leading-relaxed whitespace-pre-wrap text-secondary",
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
    runs,
    busy,
    onRun,
    stacked,
}: {
    step: { id: string; title: string };
    last: RunRecord;
    runs: RunRecord[];
    busy: boolean;
    onRun: () => void;
    stacked?: boolean;
}) {
    const t = useT();
    const [logMode, setLogMode] = useState<RunLogMode>("auto");
    const running = last?.state === "running";
    const full = logMode === "full";
    const showLog = runLogVisible(last, logMode, runStale(last, runs, Date.now()));
    const when = last ? timeAgo(new Date(last.startedat).toISOString()) : "";
    const hide = () => {
        setLogMode("hidden");
        if (last.state !== "running") {
            fireAndForget(() => missionClose(last.dir, last.id));
        }
    };
    const logButtons = last ? (
        <>
            <button type="button" className={PlainButton} onClick={() => setLogMode(full ? "hidden" : "full")}>
                {full ? t("mc.run.less") : t("mc.run.log")}
            </button>
            {showLog && !full ? (
                <button type="button" className={PlainButton} onClick={hide}>
                    {t("mc.run.hide")}
                </button>
            ) : null}
        </>
    ) : null;
    const runButton = running ? (
        <button
            type="button"
            className={PlainButton}
            onClick={() => fireAndForget(() => missionCancel(last.dir, last.id))}
        >
            {t("common.cancel")}
        </button>
    ) : (
        <button
            type="button"
            disabled={busy}
            onClick={onRun}
            className="molten-btn cursor-pointer rounded-6 px-2 py-1 text-12 disabled:cursor-default disabled:opacity-50"
        >
            {t("mc.run.run")}
            <MoltenWave />
        </button>
    );
    if (stacked) {
        return (
            <div
                className="flex flex-col gap-1.5 border-b border-border py-2.5 first:pt-0 last:border-b-0 last:pb-0"
                data-testid={`adapter-step-${step.id}`}
            >
                <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-13 text-primary" title={step.title}>
                        {step.title}
                    </span>
                    {last ? <RunStateBadge state={last.state} /> : null}
                </div>
                <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-12 text-muted">
                        {last ? when : t("mc.run.notRunYet")}
                    </span>
                    {logButtons}
                    {runButton}
                </div>
                {showLog ? <LastLines run={last} full={full} /> : null}
            </div>
        );
    }
    return (
        <div className="border-b border-border px-3 py-2 last:border-b-0" data-testid={`adapter-step-${step.id}`}>
            <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-13 leading-5 text-primary">{step.title}</span>
                {last ? (
                    <>
                        <RunStateBadge state={last.state} />
                        <span className="text-12 text-muted">{when}</span>
                        {logButtons}
                    </>
                ) : null}
                {runButton}
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
    git,
}: {
    dir: string;
    projectName: string;
    pipeline: PipelineDef;
    runs: RunRecord[];
    section: PipelineSection;
    // Inside a card that already frames and titles it (the Project overview's Project steps card): each step on two
    // lines, which fits a quarter of the row.
    bare?: boolean;
    // What a deploy takes, named when a step's environment asks first (#559).
    git?: MissionGit;
}) {
    const t = useT();
    const { start, prompt, error, clearError } = useStartRun(dir, projectName);
    const { deploy, dialog } = useConfirmedDeploy(deployRevision(git), (stepId) => start("step", stepId));
    const steps = (pipeline?.steps ?? []).filter((s) => s.section === section);
    if (steps.length === 0) {
        return null;
    }
    const anyRunning = (runs ?? []).some((r) => r.kind === "step" && r.state === "running");
    return (
        <section className="flex flex-col gap-2">
            {bare ? null : <BlockHeader title={t("mc.steps.title")} hint={t("mc.steps.hint")} />}
            <div className={cn("overflow-hidden", !bare && "rounded-4 border border-border")}>
                {steps.map((step) => (
                    <StepRow
                        key={`${step.id}:${lastRun(runs, step.id)?.id ?? ""}`}
                        step={step}
                        last={lastRun(runs, step.id)}
                        runs={runs}
                        busy={anyRunning}
                        onRun={() => deploy(deployTarget(step, runs))}
                        stacked={bare}
                    />
                ))}
            </div>
            {error ? (
                <button type="button" onClick={clearError} className="cursor-pointer text-left text-12 text-error">
                    {error}
                </button>
            ) : null}
            {prompt}
            {dialog}
        </section>
    );
}
