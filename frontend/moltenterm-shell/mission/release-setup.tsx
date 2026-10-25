// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The deployment pipeline setup (FR-MC-036, FR-MC-038, DS-MC-030): a stepper over the window, like Validate's (#672).
// It drafts the missing release flow from the repository (SaaSFoundryAI's CLI when it offers one, else MoltenTerm's
// detection), lets the developer confirm the app type, what to set up and each choice with a live diagram, then shows
// the whole flow and the diff of .molten/project.json. The setup reads the committed pipeline and never writes the folder opened: the click
// opens a draft pull request from a worktree of its own (#1098); the new commands ask for trust once it is merged.

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useMemo, useRef, useState } from "react";
import { DialogFrame } from "../dialog-frame";
import { useT, useTCount } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import { AnalyseStep } from "./release-setup-analyse";
import {
    analysePipeline,
    optionsOfAnswers,
    pendingPoints,
    PointAnswers,
    pointNumbers,
    sameOptions,
} from "./release-setup-analyse-model";
import {
    setupDraft,
    setupModels,
    setupSaveAnswers,
    setupSurvey,
    setupUpdate,
    setupWrite,
} from "./release-setup-client";
import { DescribeStep } from "./release-setup-describe";
import { describeDefaults, DescribeFrom, describes, SetupModel, undescribed } from "./release-setup-describe-model";
import { DetectStep } from "./release-setup-detect";
import { FlowDiagram } from "./release-setup-diagram";
import {
    addManual,
    canOpenPr,
    diffHunks,
    flowModel,
    lineDiff,
    prRequestOf,
    removeManual,
    SetupChannel,
    SetupChoice,
    SetupDraft,
    SetupKind,
    SetupOptions,
    SetupProposalResult,
    SetupTicketChoice,
    toggled,
    validTagPrefix,
} from "./release-setup-model";
import { PrFooterButtons, PrPanel, UncommittedNotice, useCopyPatch, useSetupPr } from "./release-setup-pr";
import { PreparedStep } from "./release-setup-prepared";
import { proposedFiles } from "./release-setup-prepared-model";
import { FlowReasons, LabelsSection, ReconcileCheck } from "./release-setup-reasons";
import {
    kindOfAppType,
    nextLabelKey,
    resumeStep,
    SetupAppType,
    SetupPath,
    SetupSurvey,
    stepIndex,
    StepperStep,
    StepperSteps,
    stepReachable,
} from "./release-setup-stepper";
import { UpdateFiles, updateReady, UpdateStep, useSetupCheck } from "./release-setup-update";

export const NewTicketChoice: SetupTicketChoice = { ticket: 0, create: true, title: "" };

const PlainButton =
    "cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";
const SectionClass = "flex flex-col gap-2 rounded-6 border border-border p-3";
const SectionTitle = "text-12 font-medium text-primary";

function Check({
    checked,
    onChange,
    label,
    hint,
    disabled,
    testId,
}: {
    checked: boolean;
    onChange: (on: boolean) => void;
    label: string;
    hint?: string;
    disabled?: boolean;
    testId?: string;
}) {
    return (
        <label className={cn("flex items-start gap-2 text-12", disabled ? "opacity-50" : "cursor-pointer")}>
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked)}
                className="mt-0.5 cursor-pointer"
                data-testid={testId}
            />
            <span className="flex min-w-0 flex-col wrap-anywhere">
                <span className="text-primary">{label}</span>
                {hint ? <span className="text-11 text-muted">{hint}</span> : null}
            </span>
        </label>
    );
}

function Choices({
    name,
    choices,
    value,
    onChange,
    labelOf,
}: {
    name: string;
    choices: SetupChoice[];
    value: string;
    onChange: (id: string) => void;
    labelOf: (id: string) => string;
}) {
    const t = useT();
    return (
        <div className="flex flex-col gap-1.5" role="radiogroup">
            {(choices ?? []).map((choice) => (
                <label
                    key={choice.id}
                    className={cn("flex items-start gap-2 text-12", choice.allowed ? "cursor-pointer" : "opacity-60")}
                    data-testid={`setup-choice-${name}-${choice.id}`}
                >
                    <input
                        type="radio"
                        name={name}
                        checked={value === choice.id}
                        disabled={!choice.allowed}
                        onChange={() => onChange(choice.id)}
                        className="mt-0.5 cursor-pointer"
                    />
                    <span className="flex min-w-0 flex-col wrap-anywhere">
                        <span className="text-primary">{labelOf(choice.id)}</span>
                        {(choice.reasons ?? []).map((reason) => (
                            <span
                                key={reason.code}
                                className={cn("text-11", reason.refuses ? "text-warning" : "text-muted")}
                            >
                                {t(`mc.setup.reason.${reason.code}`, { target: reason.target ?? "" })}
                            </span>
                        ))}
                    </span>
                </label>
            ))}
        </div>
    );
}

function ManualForm({
    draft,
    options,
    onAdd,
}: {
    draft: SetupDraft;
    options: SetupOptions;
    onAdd: (o: SetupOptions) => void;
}) {
    const t = useT();
    const [title, setTitle] = useState("");
    const [text, setText] = useState("");
    const [channel, setChannel] = useState<"" | SetupChannel>("");
    const [before, setBefore] = useState("");
    const steps = [...(draft.proposal.release?.rc ?? []), ...(draft.proposal.release?.public ?? [])];
    const ids = [...new Set(steps.map((s) => s.id))];
    const add = () => {
        if (!title.trim() || !text.trim()) {
            return;
        }
        onAdd(addManual(options, { title: title.trim(), text: text.trim(), channel, before }, ids));
        setTitle("");
        setText("");
    };
    return (
        <div
            className="flex flex-col gap-1.5 rounded-4 border border-dashed border-border p-2"
            data-testid="setup-manual-form"
        >
            <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("mc.setup.manual.titlePlaceholder")}
                className="rounded-4 border border-border bg-transparent px-2 py-1 text-12 text-primary"
                data-testid="setup-manual-title"
            />
            <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t("mc.setup.manual.textPlaceholder")}
                rows={2}
                className="rounded-4 border border-border bg-transparent px-2 py-1 font-mono text-11 text-primary"
                data-testid="setup-manual-text"
            />
            <div className="flex flex-wrap items-center gap-2 text-11 text-muted">
                <label className="flex items-center gap-1">
                    {t("mc.setup.manual.channel")}
                    <select
                        value={channel}
                        onChange={(e) => setChannel(e.target.value as "" | SetupChannel)}
                        className="cursor-pointer rounded-4 border border-border bg-transparent px-1 py-0.5 text-11 text-primary"
                    >
                        <option value="">{t("mc.setup.manual.both")}</option>
                        <option value="rc">{t("mc.setup.flow.rc")}</option>
                        <option value="public">{t("mc.setup.flow.public")}</option>
                    </select>
                </label>
                <label className="flex items-center gap-1">
                    {t("mc.setup.manual.before")}
                    <select
                        value={before}
                        onChange={(e) => setBefore(e.target.value)}
                        className="cursor-pointer rounded-4 border border-border bg-transparent px-1 py-0.5 text-11 text-primary"
                        data-testid="setup-manual-before"
                    >
                        <option value="">{t("mc.setup.manual.beforeCut")}</option>
                        {ids.map((id) => (
                            <option key={id} value={id}>
                                {id}
                            </option>
                        ))}
                    </select>
                </label>
                <button
                    type="button"
                    disabled={!title.trim() || !text.trim()}
                    onClick={add}
                    className={cn(PlainButton, "ml-auto py-1 text-11")}
                    data-testid="setup-manual-add"
                >
                    {t("mc.setup.manual.add")}
                </button>
            </div>
        </div>
    );
}

export function WhatStep({
    draft,
    options,
    onChange,
}: {
    draft: SetupDraft;
    options: SetupOptions;
    onChange: (o: SetupOptions) => void;
}) {
    const t = useT();
    if (options.kind === "saas") {
        const envs = draft.deploytargets.filter((d) => d.dispatch);
        return (
            <div className="flex flex-col gap-3">
                <p className="text-12 text-secondary">{t("mc.setup.what.saasIntro")}</p>
                {envs.length === 0 ? (
                    <p className="text-12 text-warning">{t("mc.setup.what.noEnvironment")}</p>
                ) : (
                    envs.map((d) => (
                        <Check
                            key={`${d.workflow}:${d.environment}`}
                            checked={options.environments.includes(d.environment)}
                            onChange={(on) =>
                                onChange({ ...options, environments: toggled(options.environments, d.environment, on) })
                            }
                            label={d.environment}
                            hint={t("mc.setup.what.environmentHint", {
                                workflow: d.workflow,
                                branch: draft.facts.branches.release,
                            })}
                        />
                    ))
                )}
                <p className="text-11 text-muted">{t("mc.setup.what.saasLater")}</p>
            </div>
        );
    }
    const missing = draft.facts.missing;
    return (
        <div className="flex flex-col gap-3">
            <p className="text-12 text-secondary">{t("mc.setup.what.intro")}</p>
            {(["rc", "public"] as SetupChannel[]).map((channel) => (
                <Check
                    key={channel}
                    checked={options.channels.includes(channel)}
                    onChange={(on) => onChange({ ...options, channels: toggled(options.channels, channel, on) })}
                    label={t(`mc.setup.flow.${channel}`)}
                    hint={missing.includes(channel) ? t("mc.setup.what.missing") : t("mc.setup.what.replaces")}
                    testId={`setup-channel-${channel}`}
                />
            ))}
        </div>
    );
}

export function ChoicesStep({
    draft,
    options,
    onChange,
    channel,
    setChannel,
    bare,
}: {
    draft: SetupDraft;
    options: SetupOptions;
    onChange: (o: SetupOptions) => void;
    channel: SetupChannel;
    setChannel: (c: SetupChannel) => void;
    // Without the draft's diagram and reasons: step 2a of a project already set up draws its own (#1102).
    bare?: boolean;
}) {
    const t = useT();
    const facts = draft.facts;
    if (options.kind === "saas") {
        return (
            <div className="flex flex-col gap-3">
                <FlowDiagram model={flowModel(draft, channel, options.tagprefix)} />
                <p className="text-12 text-secondary">{t("mc.setup.choices.saasIntro")}</p>
            </div>
        );
    }
    // The pull-request flow waits for the release branch's required checks instead of a promotion's CI.
    const ciWorkflows = options.branchmodel === "rcpr" ? [] : facts.workflows.filter((w) => w.role === "ci");
    const dispatchable = facts.workflows.filter(
        (w) => w.dispatch && (w.role === "docs" || w.role === "deploy") && !(w.requiredinputs?.length > 0)
    );
    const prefixOk = validTagPrefix(options.tagprefix);
    return (
        <div className="flex flex-col gap-3">
            {options.channels.length > 1 ? (
                <div className="flex gap-1" role="tablist">
                    {options.channels.map((c) => (
                        <button
                            key={c}
                            type="button"
                            role="tab"
                            aria-selected={channel === c}
                            onClick={() => setChannel(c)}
                            className={cn(
                                PlainButton,
                                "py-1 text-11",
                                channel === c && "border-accent/60 text-primary"
                            )}
                        >
                            {t(`mc.setup.flow.${c}`)}
                        </button>
                    ))}
                </div>
            ) : null}
            {bare ? null : <FlowDiagram model={flowModel(draft, channel, options.tagprefix)} />}
            {bare ? null : <FlowReasons draft={draft} options={options} />}
            <div className="grid grid-cols-1 gap-3 @min-[40rem]:grid-cols-2 @min-[80rem]:grid-cols-3">
                <div className={SectionClass}>
                    <div className={SectionTitle}>{t("mc.setup.choices.branchModel")}</div>
                    <Choices
                        name="branchmodel"
                        choices={draft.branchmodels}
                        value={options.branchmodel}
                        onChange={(id) =>
                            onChange({
                                ...options,
                                branchmodel: id,
                                syncback: id === "single" ? false : options.syncback,
                                reconcile: id === "rcpr" ? !(facts.divergence?.notequivalent > 0) : false,
                            })
                        }
                        labelOf={(id) =>
                            t(`mc.setup.branchModel.${id}`, {
                                trunk: facts.branches.trunk,
                                release: facts.branches.release,
                                pattern: facts.rcbranchpattern || "rc-{version}",
                            })
                        }
                    />
                    <ReconcileCheck draft={draft} options={options} onChange={onChange} />
                </div>
                <div className={SectionClass}>
                    <div className={SectionTitle}>{t("mc.setup.choices.merge")}</div>
                    <Choices
                        name="merge"
                        choices={draft.merges}
                        value={options.merge}
                        onChange={(id) => onChange({ ...options, merge: id })}
                        labelOf={(id) => t(`mc.setup.merge.${id}`)}
                    />
                </div>
                <div className={SectionClass}>
                    <div className={SectionTitle}>{t("mc.setup.choices.tags")}</div>
                    <label className="flex items-center gap-2 text-12 text-secondary">
                        {t("mc.setup.choices.tagPrefix")}
                        <input
                            value={options.tagprefix}
                            onChange={(e) => onChange({ ...options, tagprefix: e.target.value.trim() })}
                            aria-invalid={!prefixOk}
                            className={cn(
                                "w-20 rounded-4 border bg-transparent px-2 py-0.5 font-mono text-12 text-primary",
                                prefixOk ? "border-border" : "border-error/60"
                            )}
                        />
                    </label>
                    <Choices
                        name="rcformat"
                        choices={draft.rcformats}
                        value={options.rcformat}
                        onChange={(id) => onChange({ ...options, rcformat: id })}
                        labelOf={(id) => t(`mc.setup.rcFormat.${id}`, { prefix: options.tagprefix })}
                    />
                </div>
                <div className={SectionClass}>
                    <div className={SectionTitle}>{t("mc.setup.choices.notes")}</div>
                    <label className="flex items-center gap-2 text-12 text-secondary">
                        {t("mc.setup.choices.notesPath")}
                        <input
                            value={options.notespath}
                            onChange={(e) => onChange({ ...options, notespath: e.target.value.trim() })}
                            className="min-w-0 flex-1 rounded-4 border border-border bg-transparent px-2 py-0.5 font-mono text-12 text-primary"
                            data-testid="setup-notes-path"
                        />
                    </label>
                    <p className="text-11 text-muted">{t("mc.setup.choices.notesHow")}</p>
                    <Check
                        checked={options.notes}
                        onChange={(on) => onChange({ ...options, notes: on })}
                        label={t("mc.setup.choices.notesAgent")}
                        hint={t("mc.setup.choices.notesAgentHint")}
                    />
                    {facts.changelogs.map((c) => (
                        <Check
                            key={c.path}
                            checked={options.changelogs.includes(c.path)}
                            onChange={(on) =>
                                onChange({ ...options, changelogs: toggled(options.changelogs, c.path, on) })
                            }
                            label={t("mc.setup.choices.changelog", { path: c.path, lang: c.lang.toUpperCase() })}
                            hint={t("mc.setup.choices.changelogHint")}
                        />
                    ))}
                </div>
                <div className={SectionClass}>
                    <div className={SectionTitle}>{t("mc.setup.choices.workflows")}</div>
                    {ciWorkflows.map((w) => (
                        <Check
                            key={w.file}
                            checked={options.ciworkflows.includes(w.file)}
                            onChange={(on) =>
                                onChange({ ...options, ciworkflows: toggled(options.ciworkflows, w.file, on) })
                            }
                            label={t("mc.setup.choices.ciWorkflow", { file: w.file })}
                            hint={t("mc.setup.choices.ciWorkflowHint", { trunk: facts.branches.trunk })}
                        />
                    ))}
                    {(draft.tagworkflows?.[channel] ?? []).map((w) => (
                        <div key={w.file} className="text-12 text-primary">
                            {t("mc.setup.choices.tagWorkflow", { file: w.file })}
                            {w.environments.length > 0 ? (
                                <div className="text-11 text-warning">
                                    {t("mc.setup.choices.approval", { environment: w.environments.join(", ") })}
                                </div>
                            ) : null}
                        </div>
                    ))}
                    {dispatchable.map((w) => {
                        const on = options.dispatch.some((d) => d.workflow === w.file);
                        return (
                            <Check
                                key={w.file}
                                checked={on}
                                onChange={(next) =>
                                    onChange({
                                        ...options,
                                        dispatch: next
                                            ? [...options.dispatch, { workflow: w.file, channel: "public" }]
                                            : options.dispatch.filter((d) => d.workflow !== w.file),
                                    })
                                }
                                label={t("mc.setup.choices.dispatch", { file: w.file })}
                                hint={
                                    w.environments?.length
                                        ? t("mc.setup.choices.approval", { environment: w.environments.join(", ") })
                                        : t("mc.setup.choices.dispatchHint")
                                }
                            />
                        );
                    })}
                </div>
                <div className={SectionClass}>
                    <div className={SectionTitle}>{t("mc.setup.choices.after")}</div>
                    <Check
                        checked={options.syncback}
                        disabled={options.branchmodel === "single"}
                        onChange={(on) => onChange({ ...options, syncback: on })}
                        label={t("mc.setup.choices.syncBack", { trunk: facts.branches.trunk })}
                    />
                    <Check
                        checked={options.milestone}
                        disabled={!facts.ongithub}
                        onChange={(on) => onChange({ ...options, milestone: on })}
                        label={t("mc.setup.choices.milestone")}
                    />
                </div>
                <LabelsSection
                    draft={draft}
                    options={options}
                    onChange={onChange}
                    sectionClass={SectionClass}
                    titleClass={SectionTitle}
                />
            </div>
            <div className={SectionClass}>
                <div className={SectionTitle}>{t("mc.setup.choices.manual")}</div>
                <p className="text-11 text-muted">{t("mc.setup.choices.manualHint")}</p>
                {options.manual.map((m) => (
                    <div key={m.id} className="flex items-start gap-2 text-12" data-testid="setup-manual-row">
                        <i className="fa fa-solid fa-hand mt-0.5 text-11 text-accent" />
                        <span className="min-w-0 flex-1">
                            <span className="text-primary">{m.title}</span>
                            <span className="block font-mono text-11 whitespace-pre-wrap text-muted wrap-anywhere">
                                {m.text}
                            </span>
                        </span>
                        <button
                            type="button"
                            onClick={() => onChange(removeManual(options, m.id))}
                            className="cursor-pointer text-11 text-muted hover:text-primary"
                        >
                            {t("mc.setup.manual.remove")}
                        </button>
                    </div>
                ))}
                <ManualForm draft={draft} options={options} onAdd={onChange} />
            </div>
        </div>
    );
}

export function DiffView({ before, after }: { before: string; after: string }) {
    const t = useT();
    const rows = diffHunks(lineDiff(before, after));
    return (
        <div
            className="max-h-[max(18rem,calc(100vh-26rem))] overflow-auto rounded-6 border border-border bg-black/30 font-mono text-11"
            data-testid="setup-diff"
        >
            {rows.map((row, i) =>
                row.kind === "fold" ? (
                    <div key={i} className="px-2 py-0.5 text-muted">
                        {t("mc.setup.review.folded", { count: row.count })}
                    </div>
                ) : (
                    <div
                        key={i}
                        className={cn(
                            "flex w-max min-w-full whitespace-pre",
                            row.kind === "add" && "bg-success/10 text-success",
                            row.kind === "del" && "bg-error/10 text-danger",
                            row.kind === "same" && "text-secondary"
                        )}
                    >
                        <span className="w-10 shrink-0 pr-2 text-right text-muted select-none">
                            {row.newNo ?? row.oldNo}
                        </span>
                        <span className="w-3 shrink-0 select-none">
                            {row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}
                        </span>
                        <span>{row.text}</span>
                    </div>
                )
            )}
        </div>
    );
}

function StepBar({
    step,
    survey,
    appType,
    path,
    ready,
    locked,
    onStep,
    update,
}: {
    step: StepperStep;
    survey: SetupSurvey;
    appType: SetupAppType;
    path: SetupPath;
    ready: boolean;
    locked: boolean;
    onStep: (s: StepperStep) => void;
    // Step 2a of a project already set up (#1102): how many changes the update proposes; null otherwise.
    update?: { changes: number };
}) {
    const t = useT();
    const tCount = useTCount();
    const at = stepIndex(step);
    const sub = (s: StepperStep, i: number): string => {
        if (s === "detect") {
            if (survey == null || appType == null) {
                return t("mc.setup.stepper.reading");
            }
            const type = t(`mc.setup.appType.${appType}Short`);
            return survey.ships
                ? t("mc.setup.stepper.detectShips", { type })
                : t("mc.setup.stepper.detectNoShips", { type });
        }
        if (s === "template") {
            return t("mc.setup.stepper.optional");
        }
        if (i > at) {
            return "—";
        }
        if (s === "understand" && update != null && path === "analyse") {
            return update.changes > 0
                ? tCount("mc.setup.stepper.updateSub", update.changes)
                : t("mc.setup.stepper.upToDateSub");
        }
        if (s === "understand") {
            return path === "describe" ? t("mc.setup.stepper.describeSub") : t("mc.setup.stepper.analyseSub");
        }
        return t("mc.setup.stepper.prepareSub");
    };
    return (
        <div className="@container">
            <ol className="mb-1 grid grid-cols-2 gap-1.5 @min-[44rem]:grid-cols-4" data-testid="setup-steps">
                {StepperSteps.map((s, i) => {
                    const reachable = !locked && stepReachable(s, step, ready);
                    return (
                        <li key={s} className="min-w-0">
                            <button
                                type="button"
                                disabled={!reachable || s === step}
                                onClick={() => onStep(s)}
                                title={s === "template" ? t("mc.setup.stepper.templateLater") : undefined}
                                aria-current={s === step ? "step" : undefined}
                                className={cn(
                                    "flex w-full cursor-pointer items-start gap-2 rounded-6 border px-2.5 py-1.5 text-left disabled:cursor-default",
                                    s === step
                                        ? "border-accent/70 bg-accent/10"
                                        : i < at
                                          ? "border-success/40 hover:border-success/70"
                                          : "border-border opacity-80"
                                )}
                                data-testid={`setup-step-${s}`}
                            >
                                <span
                                    className={cn(
                                        "mt-[1px] inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-11",
                                        s === step
                                            ? "border-accent text-accent"
                                            : i < at
                                              ? "border-success text-success"
                                              : "border-border text-muted"
                                    )}
                                >
                                    {i < at ? "✓" : i + 1}
                                </span>
                                <span className="flex min-w-0 flex-col">
                                    <span className="text-12 font-medium text-primary">
                                        {t(`mc.setup.stepper.step.${s}`)}
                                    </span>
                                    <span className="truncate text-11 text-muted">{sub(s, i)}</span>
                                    {s === "understand" ? (
                                        <span className="mt-0.5 flex gap-1 text-10">
                                            {(["analyse", "describe"] as SetupPath[]).map((p) => (
                                                <span
                                                    key={p}
                                                    className={cn(
                                                        "rounded-4 border px-1",
                                                        p === path
                                                            ? "border-accent/60 text-accent"
                                                            : "border-border text-muted"
                                                    )}
                                                >
                                                    {t(
                                                        p === "analyse" && update != null
                                                            ? "mc.setup.stepper.fork.update"
                                                            : `mc.setup.stepper.fork.${p}`
                                                    )}
                                                </span>
                                            ))}
                                        </span>
                                    ) : null}
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}

// The deployment pipeline setup (FR-MC-038): Detect, Understand (2a / 2b), Prepare and validate, Template. Step 3 is
// the prepared pipeline with its exact changes and its pull request (#1104, release-setup-prepared.tsx). The answers
// are kept per project between openings. A project already set up takes path 2a through the update check (#1102,
// FR-MC-040): step 2 shows its declared pipeline and the changes, step 3 opens the update's pull request.
export function ReleaseSetup({
    dir,
    projectName,
    onClose,
    onWritten,
    openAt,
}: {
    dir: string;
    projectName: string;
    onClose: () => void;
    onWritten: () => void;
    // The step to open at instead of the one saved: the Release menu's update opens at step 2 (#1102).
    openAt?: StepperStep;
}) {
    const t = useT();
    const tCount = useTCount();
    const [draft, setDraft] = useState<SetupDraft>(null);
    const [options, setOptions] = useState<SetupOptions>(null);
    // Step 2a's answers to the points of the existing pipeline (FR-MC-040).
    const [pointAnswers, setPointAnswers] = useState<PointAnswers>({});
    const [touched, setTouched] = useState(false);
    // Who drafted before the developer changed a choice: their choices then replace SaaSFoundryAI's draft.
    const [firstProvider, setFirstProvider] = useState<SetupDraft["provider"]>(null);
    const [step, setStep] = useState<StepperStep>("detect");
    const [survey, setSurvey] = useState<SetupSurvey>(null);
    const [surveyError, setSurveyError] = useState<string>(null);
    const [appType, setAppType] = useState<SetupAppType>(null);
    const [path, setPath] = useState<SetupPath>("analyse");
    // The answers are saved only once the saved ones were read, so an opening never overwrites them with blanks.
    const [resumed, setResumed] = useState(false);
    const [channel, setChannel] = useState<SetupChannel>("rc");
    const [error, setError] = useState<string>(null);
    const [loading, setLoading] = useState(true);
    const [refined, setRefined] = useState<SetupProposalResult>(null);
    const [refining, setRefining] = useState(false);
    // Step 2b (FR-MC-041): where it started from, the model project, the words for the agent, the models read.
    const [from, setFrom] = useState<DescribeFrom>("standard");
    const [model, setModel] = useState("");
    const [words, setWords] = useState("");
    const [models, setModels] = useState<SetupModel[]>(null);
    // The proposal's cards live in the Prepare step: leaving it goes back to the draft (#1099).
    const goTo = (next: StepperStep) => {
        if (next !== "prepare") {
            setRefined(null);
            setRefining(false);
        }
        setStep(next);
    };
    const [includeLocal, setIncludeLocal] = useState(false);
    const [ticket, setTicket] = useState<SetupTicketChoice>(NewTicketChoice);
    const pr = useSetupPr();
    useCopyPatch(pr.job);
    const writing = pr.busy;
    const request = useRef(0);
    const upd = useSetupCheck(dir);

    const load = (opts: SetupOptions, kind?: SetupKind, include = includeLocal) =>
        fireAndForget(async () => {
            const n = ++request.current;
            setLoading(true);
            try {
                const answer = await setupDraft(dir, opts, kind, include);
                if (n !== request.current) {
                    return;
                }
                setDraft(answer);
                setOptions(answer.options);
                if (opts == null) {
                    setFirstProvider(answer.provider);
                }
                setRefined(null);
                setError(null);
                if (!answer.options.channels.includes(channel) && answer.options.channels.length > 0) {
                    setChannel(answer.options.channels[0]);
                }
            } catch (e) {
                if (n === request.current) {
                    setError(serverErrorText(e));
                }
            } finally {
                if (n === request.current) {
                    setLoading(false);
                }
            }
        });

    // Step 1's survey first: the app type it detects (or the one saved) picks the template the draft starts from.
    useEffect(() => {
        let cancelled = false;
        fireAndForget(async () => {
            let answer: SetupSurvey = null;
            try {
                answer = await setupSurvey(dir);
            } catch (e) {
                if (!cancelled) {
                    setSurveyError(serverErrorText(e));
                }
            }
            if (cancelled) {
                return;
            }
            const saved = answer?.answers;
            const type = saved?.apptype ?? answer?.apptype ?? null;
            setSurvey(answer);
            setAppType(type);
            setPath(saved?.path ?? answer?.recommended ?? "analyse");
            setPointAnswers(saved?.points ?? {});
            setWords(saved?.words ?? "");
            setFrom(saved?.from ?? "standard");
            setModel(saved?.model ?? "");
            if (saved?.touched && saved.options != null) {
                setTouched(true);
                load(saved.options);
            } else {
                load(null, type ? kindOfAppType(type) : undefined);
            }
            if (answer?.pipeline === "complete") {
                upd.start(saved?.update);
            }
            setStep(openAt && type ? openAt : resumeStep(saved));
            setResumed(true);
        });
        return () => {
            cancelled = true;
        };
    }, [dir]);

    const done = pr.job?.finished && pr.job.failure == null;
    useEffect(() => {
        if (!resumed || draft == null) {
            return;
        }
        const answers = done
            ? null
            : {
                  base: draft.base,
                  step,
                  apptype: appType,
                  path,
                  touched,
                  options: touched ? options : undefined,
                  points: Object.keys(pointAnswers).length > 0 ? pointAnswers : undefined,
                  words: words || undefined,
                  from: path === "describe" ? from : undefined,
                  model: path === "describe" && from === "model" ? model : undefined,
                  update:
                      upd.options != null || Object.keys(upd.choices).length > 0
                          ? { options: upd.options ?? undefined, choices: upd.choices }
                          : undefined,
              };
        fireAndForget(async () => {
            try {
                await setupSaveAnswers(dir, answers);
            } catch {
                // Resuming is a convenience: the stepper works without it.
            }
        });
    }, [
        resumed,
        draft?.base,
        step,
        appType,
        path,
        touched,
        options,
        done,
        pointAnswers,
        words,
        from,
        model,
        upd.options,
        upd.choices,
    ]);

    const describing = describes(path, appType);
    // Step 2b opens on the questions' defaults, and reads the other projects once for "another project as a model".
    useEffect(() => {
        if (!describing || step !== "understand" || draft == null || options == null || loading) {
            return;
        }
        if (options.rc == null) {
            change(describeDefaults(draft, options));
        }
    }, [describing, step, draft, options, loading]);
    useEffect(() => {
        if (!describing || step !== "understand" || models != null) {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            let list: SetupModel[] = [];
            try {
                list = (await setupModels(dir)).models ?? [];
            } catch {
                // Without the list the other starting points still work.
            }
            if (!cancelled) {
                setModels(list);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [describing, step, models, dir]);
    const choosePath = (next: SetupPath) => {
        setPath(next);
        // The description does not carry over to 2a: the analysis starts again from the repository's own draft.
        if (next === "analyse" && options?.rc != null) {
            setOptions(undescribed(options));
            setTouched(false);
            load(null, appType ? kindOfAppType(appType) : undefined);
        }
    };
    const chooseFrom = (next: DescribeFrom, dirOf?: string) => {
        setFrom(next);
        if (dirOf != null) {
            setModel(dirOf);
        }
    };

    const change = (next: SetupOptions) => {
        setOptions(next);
        setTouched(true);
        load(next);
    };
    const chooseKind = (kind: SetupKind) => {
        if (!touched || options == null) {
            load(null, kind);
            return;
        }
        change({ ...options, kind });
    };
    const chooseType = (type: SetupAppType) => {
        setAppType(type);
        const kind = kindOfAppType(type);
        if (options?.kind !== kind) {
            chooseKind(kind);
        }
    };
    const text = refined?.proposed ?? draft?.proposed ?? "";
    const errors = refined?.errors ?? draft?.errors ?? [];
    const write = (mode: "pr" | "patch") =>
        pr.start(async () => {
            const job = await setupWrite(
                dir,
                text,
                draft.base,
                draft.generated,
                prRequestOf(draft.pr, ticket, mode),
                draft.files
            );
            onWritten();
            return job;
        });
    const include = (on: boolean) => {
        setIncludeLocal(on);
        load(touched ? options : null, touched ? undefined : options?.kind, on);
    };
    // The pull request in the Reviews list, where it is validated and merged (#1104).
    const openReviews = (prDir: string, number: number) =>
        fireAndForget(async () => {
            const { ReviewsModel } = await import("../reviews/reviews-store");
            onClose();
            await ReviewsModel.getInstance().openReviews(prDir, number);
        });
    const again = () => {
        pr.reset();
        load(touched ? options : null, touched ? undefined : options?.kind);
    };

    // Path 2a of a project already set up (#1102): the update check, not the analysis points.
    const updating = survey?.pipeline === "complete" && path === "analyse" && upd.check?.state !== "missing";
    const check = updating ? upd.check : null;
    const update = (mode: "pr" | "patch") =>
        pr.start(async () => {
            const job = await setupUpdate(
                dir,
                check.base,
                check.signature,
                upd.choices,
                prRequestOf(check.pr, ticket, mode),
                upd.options ?? undefined
            );
            onWritten();
            return job;
        });
    const againUpdate = () => {
        pr.reset();
        upd.reload();
    };
    const canUpdate = (mode: "pr" | "patch") =>
        updateReady(check) && !upd.loading && !done && canOpenPr(check.pr, ticket, mode);
    const analysing = step === "understand" && path === "analyse" && !updating;
    const points = useMemo(() => analysePipeline(survey, draft), [survey, draft]);
    const pending = analysing ? pendingPoints(points, pointAnswers) : [];
    const answerPoint = (key: string, value: string) => {
        const next = { ...pointAnswers, [key]: value };
        setPointAnswers(next);
        if (options == null || draft == null) {
            return;
        }
        const patched = optionsOfAnswers(options, draft, points, next, [key]);
        if (!sameOptions(patched, options)) {
            change(patched);
        }
    };
    // Leaving 2a: the points not answered count as the repository reads them.
    const goNext = (to: StepperStep) => {
        if (analysing && options != null && draft != null) {
            const unanswered = points.filter((p) => pointAnswers[p.key] == null).map((p) => p.key);
            const patched = optionsOfAnswers(options, draft, points, pointAnswers, unanswered);
            if (!sameOptions(patched, options)) {
                change(patched);
            }
        }
        goTo(to);
    };

    const at = stepIndex(step);
    const nothing = options != null && options.kind !== "saas" && options.channels.length === 0;
    const canWrite =
        draft != null &&
        !loading &&
        !refining &&
        errors.length === 0 &&
        text !== draft.current &&
        !nothing &&
        !done &&
        canOpenPr(draft.pr, ticket, "pr");
    const canPatch =
        draft != null &&
        !loading &&
        !refining &&
        errors.length === 0 &&
        text !== draft.current &&
        !nothing &&
        !done &&
        canOpenPr(draft.pr, ticket, "patch");
    const ready =
        draft != null &&
        options != null &&
        (step === "detect"
            ? appType != null && !(survey?.pipeline === "complete" && upd.check == null && upd.error == null)
            : step === "understand" &&
              (updating
                  ? check != null && !upd.loading && check.errors.length === 0
                  : !nothing && pending.length === 0));
    const next = StepperSteps[at + 1];
    const uncommitted =
        check != null ? (
            <UncommittedNotice plan={check.pr} current={check.current} onInclude={upd.include} asChanges />
        ) : draft != null ? (
            <UncommittedNotice plan={draft.pr} current={draft.current} onInclude={include} />
        ) : null;
    return (
        <DialogFrame
            role="mc-release-setup"
            title={t("mc.setup.title", { project: projectName })}
            subtitle={t("mc.setup.subtitle")}
            subtitleWraps
            fill
            onEscape={writing ? undefined : onClose}
            buttons={
                <>
                    <span className="mr-auto flex items-center gap-2 text-11 text-muted">
                        {loading || upd.loading ? <DominoLoader /> : null}
                        {done ? null : (
                            <span data-testid="setup-step-of">
                                {t("mc.setup.stepper.stepOf", { n: at + 1, total: StepperSteps.length })}
                            </span>
                        )}
                        {pending.length > 0 ? (
                            <span className="text-warning" data-testid="setup-pending">
                                {tCount("mc.setup.analyse.pending", pending.length, {
                                    numbers: pending.map((p) => pointNumbers(points)[p.key]).join(", "),
                                })}
                            </span>
                        ) : null}
                    </span>
                    {at > 0 && !done ? (
                        <button
                            type="button"
                            className={PlainButton}
                            onClick={() => goTo(StepperSteps[at - 1])}
                            disabled={writing}
                        >
                            {t("mc.setup.back")}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className={PlainButton}
                        onClick={onClose}
                        disabled={writing}
                        data-testid="setup-close"
                    >
                        {done ? t("common.close") : t("mc.setup.stepper.close")}
                    </button>
                    {step !== "prepare" ? (
                        <button
                            key="next"
                            type="button"
                            className="molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12 disabled:cursor-default disabled:opacity-50"
                            disabled={!ready}
                            onClick={() => goNext(next)}
                            data-testid="setup-next"
                        >
                            {t(
                                updating && step === "understand"
                                    ? "mc.setup.stepper.nextUpdate"
                                    : nextLabelKey(step, path)
                            )}
                            <MoltenWave />
                        </button>
                    ) : check != null ? (
                        <PrFooterButtons
                            plan={check.pr}
                            job={pr.job}
                            busy={writing}
                            canOpen={canUpdate("pr")}
                            canPatch={canUpdate("patch")}
                            onOpen={update}
                        />
                    ) : (
                        <PrFooterButtons
                            plan={draft?.pr}
                            job={pr.job}
                            busy={writing}
                            canOpen={canWrite}
                            canPatch={canPatch}
                            onOpen={write}
                        />
                    )}
                </>
            }
        >
            <StepBar
                step={step}
                survey={survey}
                appType={appType}
                path={path}
                ready={ready}
                locked={draft == null || writing || done}
                onStep={goNext}
                update={check != null ? { changes: check.changes.length } : undefined}
            />
            {error || (updating && upd.error) ? (
                <p
                    className="rounded-4 border border-error/40 bg-error/10 px-2 py-1.5 text-12 text-danger"
                    role="alert"
                >
                    {error || upd.error}
                </p>
            ) : null}
            {step === "detect" ? (
                survey == null && surveyError == null ? (
                    <div className="flex items-center gap-2 py-6 text-12 text-muted">
                        <DominoLoader />
                        {t("mc.setup.reading")}
                    </div>
                ) : (
                    <div className="@container flex flex-col gap-3">
                        {draft == null || writing || done ? null : uncommitted}
                        <DetectStep
                            survey={survey}
                            error={surveyError}
                            pipelineRef={draft?.pr?.ref ?? ""}
                            appType={appType}
                            path={path}
                            onType={chooseType}
                            onPath={choosePath}
                        />
                    </div>
                )
            ) : draft == null || options == null ? (
                error ? null : (
                    <div className="flex items-center gap-2 py-6 text-12 text-muted">
                        <DominoLoader />
                        {t("mc.setup.reading")}
                    </div>
                )
            ) : (
                <div className="@container flex flex-col gap-3">
                    {draft.provider === "saasfoundry" && !touched ? (
                        <p className="text-11 text-muted">{t("mc.setup.fromSaaSFoundry")}</p>
                    ) : null}
                    {touched && firstProvider === "saasfoundry" && draft.provider === "moltenterm" ? (
                        <p className="text-11 text-muted">{t("mc.setup.choicesReplace")}</p>
                    ) : null}
                    {writing || done ? null : uncommitted}
                    {step === "understand" && updating ? (
                        check == null ? (
                            upd.error ? null : (
                                <div className="flex items-center gap-2 py-6 text-12 text-muted">
                                    <DominoLoader />
                                    {t("mc.setup.reading")}
                                </div>
                            )
                        ) : (
                            <UpdateStep draft={draft} check={check} choices={upd.choices} onChoose={upd.choose}>
                                <ChoicesStep
                                    draft={draft}
                                    options={{ ...options, ...(check.options ?? {}) }}
                                    onChange={upd.adjust}
                                    channel={channel}
                                    setChannel={setChannel}
                                    bare
                                />
                            </UpdateStep>
                        )
                    ) : analysing ? (
                        <>
                            <AnalyseStep
                                survey={survey}
                                draft={draft}
                                points={points}
                                answers={pointAnswers}
                                onAnswer={answerPoint}
                            />
                            <details
                                className="rounded-6 border border-border px-3 py-2"
                                data-testid="setup-all-choices"
                            >
                                <summary className="cursor-pointer text-12 text-primary">
                                    {t("mc.setup.analyse.allChoices")}
                                </summary>
                                <div className="mt-2 flex flex-col gap-3">
                                    <WhatStep draft={draft} options={options} onChange={change} />
                                    {nothing ? null : (
                                        <ChoicesStep
                                            draft={draft}
                                            options={options}
                                            onChange={change}
                                            channel={channel}
                                            setChannel={setChannel}
                                        />
                                    )}
                                </div>
                            </details>
                        </>
                    ) : step === "understand" && describing ? (
                        options.rc == null ? null : (
                            <DescribeStep
                                draft={draft}
                                options={options}
                                from={from}
                                models={models}
                                model={model}
                                words={words}
                                appType={appType}
                                onChange={change}
                                onFrom={chooseFrom}
                                onWords={setWords}
                            >
                                <ChoicesStep
                                    draft={draft}
                                    options={options}
                                    onChange={change}
                                    channel={channel}
                                    setChannel={setChannel}
                                />
                            </DescribeStep>
                        )
                    ) : step === "understand" ? (
                        <>
                            <WhatStep draft={draft} options={options} onChange={change} />
                            {nothing ? null : (
                                <ChoicesStep
                                    draft={draft}
                                    options={options}
                                    onChange={change}
                                    channel={channel}
                                    setChannel={setChannel}
                                />
                            )}
                        </>
                    ) : null}
                    {step === "prepare" && check != null ? (
                        <>
                            <UpdateFiles check={check}>
                                <DiffView before={check.current} after={check.proposed} />
                            </UpdateFiles>
                            <PrPanel
                                dir={dir}
                                plan={check.pr}
                                choice={ticket}
                                onChoice={setTicket}
                                job={pr.job}
                                busy={writing}
                                error={pr.error}
                                onAgain={againUpdate}
                            />
                        </>
                    ) : null}
                    {step === "prepare" && check == null ? (
                        <PreparedStep
                            dir={dir}
                            draft={draft}
                            options={options}
                            refined={refined}
                            onRefined={setRefined}
                            onRefining={setRefining}
                            onOptions={loading ? undefined : change}
                            initialRequest={describing ? words : undefined}
                            extraFiles={proposedFiles(draft.files)}
                            pr={{
                                ticket,
                                onTicket: setTicket,
                                job: pr.job,
                                busy: writing,
                                error: pr.error,
                                onAgain: again,
                                onOpenReviews: openReviews,
                            }}
                        />
                    ) : null}
                </div>
            )}
        </DialogFrame>
    );
}
