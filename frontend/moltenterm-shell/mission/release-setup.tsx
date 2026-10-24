// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Set up the release" (FR-MC-036, DS-MC-030): a stepper over the window, like Validate's (#672). It drafts the missing
// release flow from the repository (SaaSFoundryAI's CLI when it offers one, else MoltenTerm's detection), lets the
// developer confirm the app kind, what to set up and each choice with a live diagram, then shows the whole flow and the
// diff of .molten/project.json. Only the Write click writes the file; the new commands then go through the trust sheet.

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { DialogFrame } from "../dialog-frame";
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import { missionTrust, missionUntrusted } from "./mission-client";
import { UntrustedInfo } from "./mission-model";
import { setupDraft, setupRefine, setupWrite } from "./release-setup-client";
import { FlowDiagram } from "./release-setup-diagram";
import {
    addManual,
    diffHunks,
    flowModel,
    lineDiff,
    removeManual,
    SetupChannel,
    SetupChoice,
    SetupDraft,
    SetupKind,
    SetupOptions,
    SetupRefined,
    SetupSource,
    toggled,
    validTagPrefix,
} from "./release-setup-model";
import { FlowReasons, LabelsSection, ReconcileCheck } from "./release-setup-reasons";
import { TrustPrompt } from "./runs-view";

type StepId = "kind" | "what" | "choices" | "review";
const Steps: StepId[] = ["kind", "what", "choices", "review"];

const PlainButton =
    "cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";
const SectionClass = "flex flex-col gap-2 rounded-6 border border-border p-3";
const SectionTitle = "text-12 font-medium text-primary";

function useSourceText() {
    const t = useT();
    return (source: SetupSource) =>
        source?.code
            ? t(`mc.setup.source.${source.code}`, { path: source.path ?? "", detail: source.detail ?? "" })
            : "";
}

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

export function KindStep({
    draft,
    options,
    onKind,
}: {
    draft: SetupDraft;
    options: SetupOptions;
    onKind: (k: SetupKind) => void;
}) {
    const t = useT();
    const sourceText = useSourceText();
    const kinds: SetupKind[] = ["on-premise", "saas"];
    return (
        <div className="flex flex-col gap-3">
            <p className="text-12 text-secondary">{t("mc.setup.kind.intro")}</p>
            {kinds.map((kind) => (
                <label
                    key={kind}
                    className={cn(
                        "flex cursor-pointer flex-col gap-1 rounded-6 border px-3 py-2",
                        options.kind === kind
                            ? "border-accent/60 bg-accent/10"
                            : "border-border hover:border-secondary/40"
                    )}
                    data-testid={`setup-kind-${kind}`}
                >
                    <span className="flex items-center gap-2 text-13 font-medium text-primary">
                        <input
                            type="radio"
                            name="setup-kind"
                            checked={options.kind === kind}
                            onChange={() => onKind(kind)}
                            className="cursor-pointer"
                        />
                        {t(`mc.setup.kind.${kind}`)}
                        {draft.facts.kind === kind ? (
                            <span className="rounded-4 border border-border px-1.5 text-10 text-muted">
                                {t("mc.setup.kind.detected")}
                            </span>
                        ) : null}
                    </span>
                    <span className="text-11 text-muted">{t(`mc.setup.kind.${kind}Hint`)}</span>
                </label>
            ))}
            <div className={SectionClass}>
                <div className={SectionTitle}>{t("mc.setup.kind.evidence")}</div>
                {draft.facts.kindevidence.length === 0 ? (
                    <div className="text-11 text-muted">{t("mc.setup.kind.noEvidence")}</div>
                ) : (
                    <ul className="flex flex-col gap-0.5 pl-4 text-11 text-secondary">
                        {draft.facts.kindevidence.map((e, i) => (
                            <li key={i} className="list-disc">
                                {sourceText(e)}
                            </li>
                        ))}
                    </ul>
                )}
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
}: {
    draft: SetupDraft;
    options: SetupOptions;
    onChange: (o: SetupOptions) => void;
    channel: SetupChannel;
    setChannel: (c: SetupChannel) => void;
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
            <FlowDiagram model={flowModel(draft, channel, options.tagprefix)} />
            <FlowReasons draft={draft} options={options} />
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

function DiffView({ before, after }: { before: string; after: string }) {
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

export function ReviewStep({
    draft,
    options,
    refined,
    refining,
    onRefine,
    onDropRefined,
}: {
    draft: SetupDraft;
    options: SetupOptions;
    refined: SetupRefined;
    refining: boolean;
    onRefine: () => void;
    onDropRefined: () => void;
}) {
    const t = useT();
    const sourceText = useSourceText();
    const proposed = refined?.proposed ?? draft.proposed;
    const errors = refined?.errors ?? draft.errors;
    const warnings = [...(draft.warnings ?? []), ...(refined?.validatewarnings ?? draft.validatewarnings ?? [])];
    const channels: SetupChannel[] = options.kind === "saas" ? ["public"] : options.channels;
    const sources = Object.entries(draft.proposal.sources ?? {});
    return (
        <div className="flex flex-col gap-3">
            {refined ? null : <FlowReasons draft={draft} options={options} />}
            {refined
                ? null
                : channels.map((c) => (
                      <div key={c} className="flex flex-col gap-1">
                          {options.kind === "saas" ? null : (
                              <div className="text-11 text-muted">{t(`mc.setup.flow.${c}`)}</div>
                          )}
                          <FlowDiagram model={flowModel(draft, c, options.tagprefix)} />
                      </div>
                  ))}
            <div className="flex flex-wrap items-center gap-2 text-12">
                <span className="text-secondary">
                    {refined
                        ? t("mc.setup.review.byAgent", { agent: refined.agentname || refined.agent })
                        : draft.provider === "saasfoundry"
                          ? t("mc.setup.review.bySaaSFoundry")
                          : t("mc.setup.review.byMoltenTerm")}
                </span>
                <span className="ml-auto flex gap-2">
                    {refined ? (
                        <button type="button" className={cn(PlainButton, "py-1 text-11")} onClick={onDropRefined}>
                            {t("mc.setup.review.backToDraft")}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        disabled={refining}
                        className={cn(PlainButton, "inline-flex items-center py-1 text-11")}
                        onClick={onRefine}
                        data-testid="setup-refine"
                        title={t("mc.setup.review.refineTitle")}
                    >
                        {refining ? (
                            <DominoLoader className="mr-1.5" />
                        ) : (
                            <i className="fa fa-solid fa-wand-magic-sparkles mr-1.5 text-11" />
                        )}
                        {refining ? t("mc.setup.review.refining") : t("mc.setup.review.refine")}
                    </button>
                </span>
            </div>
            <DiffView before={draft.current} after={proposed} />
            {errors.length > 0 ? (
                <ul
                    className="flex flex-col gap-0.5 rounded-4 border border-error/40 bg-error/10 px-3 py-1.5 text-11 text-danger"
                    role="alert"
                >
                    {errors.map((e) => (
                        <li key={e}>{e}</li>
                    ))}
                </ul>
            ) : null}
            {warnings.length > 0 ? (
                <ul className="flex flex-col gap-0.5 rounded-4 border border-warning/40 bg-warning/10 px-3 py-1.5 text-11 text-secondary">
                    {warnings.map((w) => (
                        <li key={w}>{w}</li>
                    ))}
                </ul>
            ) : null}
            {refined ? null : (
                <details className="rounded-6 border border-border px-3 py-2 text-11 text-secondary">
                    <summary className="cursor-pointer text-12 text-primary">{t("mc.setup.review.sources")}</summary>
                    <ul className="mt-1 flex flex-col gap-0.5" data-testid="setup-sources">
                        {sources.map(([key, source]) => (
                            <li key={key} className="wrap-anywhere">
                                <span className="font-mono text-muted">{key}</span> · {sourceText(source)}
                            </li>
                        ))}
                    </ul>
                </details>
            )}
            <p className="text-11 text-muted">
                {draft.facts.ticketbranches
                    ? t("mc.setup.review.ticketBranch", {
                          branch: draft.facts.currentbranch || draft.facts.branches.trunk,
                      })
                    : t("mc.setup.review.workingTree")}
            </p>
        </div>
    );
}

export function ReleaseSetup({
    dir,
    projectName,
    onClose,
    onWritten,
}: {
    dir: string;
    projectName: string;
    onClose: () => void;
    onWritten: () => void;
}) {
    const t = useT();
    const [draft, setDraft] = useState<SetupDraft>(null);
    const [options, setOptions] = useState<SetupOptions>(null);
    const [touched, setTouched] = useState(false);
    // Who drafted before the developer changed a choice: their choices then replace SaaSFoundryAI's draft.
    const [firstProvider, setFirstProvider] = useState<SetupDraft["provider"]>(null);
    const [step, setStep] = useState<StepId>("kind");
    const [channel, setChannel] = useState<SetupChannel>("rc");
    const [error, setError] = useState<string>(null);
    const [loading, setLoading] = useState(true);
    const [refined, setRefined] = useState<SetupRefined>(null);
    const [refining, setRefining] = useState(false);
    const [writing, setWriting] = useState(false);
    const [untrusted, setUntrusted] = useState<UntrustedInfo>(null);
    const request = useRef(0);

    const load = (opts: SetupOptions, kind?: SetupKind) =>
        fireAndForget(async () => {
            const n = ++request.current;
            setLoading(true);
            try {
                const answer = await setupDraft(dir, opts, kind);
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

    useEffect(() => {
        load(null);
    }, [dir]);

    const change = (next: SetupOptions) => {
        setOptions(next);
        setTouched(true);
        load(next);
    };
    const chooseKind = (kind: SetupKind) => {
        if (!touched) {
            load(null, kind);
            return;
        }
        change({ ...options, kind });
    };
    const refine = () =>
        fireAndForget(async () => {
            setRefining(true);
            setError(null);
            try {
                setRefined(await setupRefine(dir, draft.proposed));
            } catch (e) {
                setError(serverErrorText(e));
            } finally {
                setRefining(false);
            }
        });
    const text = refined?.proposed ?? draft?.proposed ?? "";
    const errors = refined?.errors ?? draft?.errors ?? [];
    const write = () =>
        fireAndForget(async () => {
            setWriting(true);
            setError(null);
            try {
                await setupWrite(dir, text, draft.base);
                onWritten();
                const info = await missionUntrusted(dir);
                if (info?.commands?.length) {
                    setUntrusted(info);
                    return;
                }
                onClose();
            } catch (e) {
                setError(serverErrorText(e));
            } finally {
                setWriting(false);
            }
        });
    const trust = () =>
        fireAndForget(async () => {
            const info = untrusted;
            try {
                await missionTrust(dir, info.hash);
                setUntrusted(null);
                onClose();
            } catch (e) {
                setError(serverErrorText(e));
            }
        });

    if (untrusted != null) {
        return (
            <TrustPrompt
                projectName={projectName}
                dir={dir}
                info={untrusted}
                approveOnly
                bodyKey="mc.setup.trustBody"
                fill
                onTrust={trust}
                onCancel={onClose}
            />
        );
    }
    const at = Steps.indexOf(step);
    const nothing = options != null && options.kind !== "saas" && options.channels.length === 0;
    const canWrite =
        draft != null && !loading && !refining && errors.length === 0 && text !== draft.current && !nothing;
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
                    {loading ? <DominoLoader className="mr-auto" /> : null}
                    <button type="button" className={PlainButton} onClick={onClose} disabled={writing}>
                        {t("common.cancel")}
                    </button>
                    {at > 0 ? (
                        <button
                            type="button"
                            className={PlainButton}
                            onClick={() => setStep(Steps[at - 1])}
                            disabled={writing}
                        >
                            {t("mc.setup.back")}
                        </button>
                    ) : null}
                    {step !== "review" ? (
                        <button
                            key="next"
                            type="button"
                            className="molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12 disabled:cursor-default disabled:opacity-50"
                            disabled={draft == null || nothing}
                            onClick={() => setStep(Steps[at + 1])}
                            data-testid="setup-next"
                        >
                            {t("mc.setup.next")}
                            <MoltenWave />
                        </button>
                    ) : (
                        <button
                            key="write"
                            type="button"
                            className="molten-btn inline-flex cursor-pointer items-center rounded-6 px-3 py-1.5 text-12 disabled:cursor-default disabled:opacity-50"
                            disabled={!canWrite || writing}
                            onClick={write}
                            data-testid="setup-write"
                        >
                            {writing ? <DominoLoader className="mr-1.5" /> : null}
                            {t("mc.setup.write")}
                            <MoltenWave />
                        </button>
                    )}
                </>
            }
        >
            <ol className="mb-1 flex flex-wrap gap-1.5" data-testid="setup-steps">
                {Steps.map((s, i) => (
                    <li key={s}>
                        <button
                            type="button"
                            disabled={draft == null || i > at + 1}
                            onClick={() => setStep(s)}
                            className={cn(
                                "flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-11 disabled:cursor-default",
                                s === step
                                    ? "border-accent/70 bg-accent/15 text-accent"
                                    : i < at
                                      ? "border-success/60 text-success"
                                      : "border-border text-muted"
                            )}
                        >
                            <span className="font-mono">{i + 1}</span>
                            {t(`mc.setup.step.${s}`)}
                        </button>
                    </li>
                ))}
            </ol>
            {error ? (
                <p
                    className="rounded-4 border border-error/40 bg-error/10 px-2 py-1.5 text-12 text-danger"
                    role="alert"
                >
                    {error}
                </p>
            ) : null}
            {draft == null || options == null ? (
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
                    {step === "kind" ? <KindStep draft={draft} options={options} onKind={chooseKind} /> : null}
                    {step === "what" ? <WhatStep draft={draft} options={options} onChange={change} /> : null}
                    {step === "choices" ? (
                        <ChoicesStep
                            draft={draft}
                            options={options}
                            onChange={change}
                            channel={channel}
                            setChannel={setChannel}
                        />
                    ) : null}
                    {step === "review" ? (
                        <ReviewStep
                            draft={draft}
                            options={options}
                            refined={refined}
                            refining={refining}
                            onRefine={refine}
                            onDropRefined={() => setRefined(null)}
                        />
                    ) : null}
                </div>
            )}
        </DialogFrame>
    );
}
