// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// "Your way of publishing" (FR-MC-044, #1151): the pipeline setup's first screen. What the survey found, told in plain
// words: one block per channel with its diagram and its numbered sentences, each with who does it; the step and its
// node light together on hover and click. A project already set up also reads what changed since last time. The
// technical detail stays behind "Show the technical details", closed at first. The setup panel renders it, whichever
// container holds the panel; the question box and each step's Question button come from the caller (#1152).

import { cn } from "@/util/util";
import { ReactNode, useMemo, useState } from "react";
import type { PillTone } from "../header/header-model";
import { Pill } from "../header/pill";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { SectionBlock } from "../suite/suite";
import { suiteIcon } from "../suite/suite-icons";
import { FlowDiagram } from "./release-setup-diagram";
import { flowModel, SetupChannel, SetupCheck, SetupDraft } from "./release-setup-model";
import {
    PlainChange,
    plainChanges,
    PlainChannel,
    plainChannels,
    PlainContext,
    plainExamples,
    plainFlowModel,
    PlainStep,
    PlainWho,
    stepPoint,
    stepText,
} from "./release-setup-plain-model";
import type { SetupSurvey } from "./release-setup-stepper";

const SecondaryButton =
    "cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

const WhoTone: Record<PlainWho, PillTone> = {
    molten: "neutral",
    you: "neutral",
    confirm: "warning",
    approve: "warning",
};

// What a step's Question button gets (#1152): the step, its number, its kind and the sentence as shown.
export type PlainQuestionStep = { channel: SetupChannel; number: number; kind: string; text: string };

export type PlainProgress = "understand" | "adjust" | "validate";

// The three markers of the setup (epic #1149): Understand, Adjust, Validate.
export function SetupProgress({ at }: { at: PlainProgress }) {
    const t = useT();
    const marks: PlainProgress[] = ["understand", "adjust", "validate"];
    const index = marks.indexOf(at);
    return (
        <ol className="flex flex-wrap items-center gap-2 text-11" data-testid="setup-progress">
            {marks.map((m, i) => (
                <li key={m} className="flex items-center gap-2">
                    {i > 0 ? <span className="h-px w-5 bg-border" aria-hidden /> : null}
                    <span
                        className={cn(
                            "flex items-center gap-1.5",
                            i === index ? "font-medium text-primary" : i < index ? "text-secondary" : "text-muted"
                        )}
                        aria-current={i === index ? "step" : undefined}
                    >
                        <span
                            className={cn(
                                "inline-flex h-4 w-4 items-center justify-center rounded-full border font-mono text-10",
                                i === index ? "border-accent text-accent" : "border-border"
                            )}
                        >
                            {i + 1}
                        </span>
                        {t(`mc.setup.plain.progress.${m}`)}
                    </span>
                </li>
            ))}
        </ol>
    );
}

function StepRow({
    step,
    text,
    lit,
    picked,
    onHover,
    onPick,
    question,
}: {
    step: PlainStep;
    text: string;
    lit: boolean;
    picked: boolean;
    onHover: (n: number) => void;
    onPick: (n: number) => void;
    question?: ReactNode;
}) {
    const t = useT();
    return (
        <li
            className={cn(
                "flex cursor-pointer flex-wrap items-start gap-x-2.5 gap-y-1 rounded-4 border px-2.5 py-2 transition-colors duration-120",
                lit ? "border-accent/60 bg-accent/10" : "border-transparent hover:bg-hover"
            )}
            onMouseEnter={() => onHover(step.n)}
            onMouseLeave={() => onHover(null)}
            onClick={() => onPick(step.n)}
            aria-selected={picked}
            data-testid={`plain-step-${step.channel}-${step.n}`}
            data-lit={lit ? "" : undefined}
        >
            <span
                className={cn(
                    "mt-px inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-11 font-semibold",
                    lit ? "bg-accent text-background" : "border border-accent/60 text-accent"
                )}
            >
                {step.n}
            </span>
            <span className="min-w-0 flex-1 basis-60 text-12 text-primary" data-testid="plain-step-text">
                {text}
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
                {question}
                <Pill
                    label={t(`mc.setup.plain.who.${step.who}`)}
                    tone={WhoTone[step.who]}
                    dot={step.who === "molten"}
                    testId="plain-step-who"
                />
                {step.ifNeeded ? <Pill label={t("mc.setup.plain.ifNeeded")} /> : null}
                {step.yours ? <Pill label={t("mc.setup.plain.yours")} testId="plain-step-yours" /> : null}
            </span>
        </li>
    );
}

function ChannelBlock({
    plain,
    ctx,
    question,
}: {
    plain: PlainChannel;
    ctx: PlainContext;
    question?: (step: PlainQuestionStep) => ReactNode;
}) {
    const t = useT();
    const [hover, setHover] = useState<number>(null);
    const [picked, setPicked] = useState<number>(null);
    const lit = hover ?? picked;
    const model = useMemo(() => plainFlowModel(plain, ctx, t), [plain, ctx, t]);
    const pointNumber = (point: string) => (point ? Number(point.slice("step-".length)) : null);
    const pick = (n: number) => setPicked((p) => (p === n ? null : n));
    return (
        <SectionBlock
            title={t(`mc.setup.plain.channel.${plain.channel}`)}
            icon={suiteIcon("ci")}
            data-testid={`plain-channel-${plain.channel}`}
        >
            <div className="flex flex-col gap-2.5 pt-1">
                <FlowDiagram
                    model={model}
                    plain
                    selected={lit != null ? stepPoint(lit) : undefined}
                    onSelect={(point) => pick(pointNumber(point))}
                    onHover={(point) => setHover(pointNumber(point))}
                />
                <ol className="flex flex-col gap-0.5">
                    {plain.steps.map((step) => {
                        const text = stepText(t, step);
                        return (
                            <StepRow
                                key={step.n}
                                step={step}
                                text={text}
                                lit={lit === step.n}
                                picked={picked === step.n}
                                onHover={setHover}
                                onPick={pick}
                                question={question?.({
                                    channel: plain.channel,
                                    number: step.n,
                                    kind: step.topic,
                                    text,
                                })}
                            />
                        );
                    })}
                </ol>
            </div>
        </SectionBlock>
    );
}

function ChangeLine({ change }: { change: PlainChange }) {
    const t = useT();
    const where = change.channel ? t(`mc.setup.plain.changes.in.${change.channel}`) : "";
    const what = change.step ? stepText(t, change.step) : t("mc.setup.plain.changes.aStep");
    const text =
        change.kind === "versions"
            ? t("mc.setup.plain.changes.versions")
            : change.local && !change.channel
              ? t("mc.setup.plain.changes.localOther")
              : t(`mc.setup.plain.changes.${change.local ? "local" : change.kind}`, { where, what });
    return (
        <li className="text-12 text-primary" data-testid={`plain-change-${change.key}`}>
            {text}
        </li>
    );
}

// The technical details (FR-MC-044): each sentence then the pipeline's steps it tells, the technical diagrams, the
// sources read and, from the caller, "All the choices", read-only. Closed at first.
function TechnicalDetails({
    channels,
    draft,
    children,
}: {
    channels: PlainChannel[];
    draft: SetupDraft;
    children?: ReactNode;
}) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const sources = Object.entries(draft.proposal?.sources ?? {});
    return (
        <details
            className="rounded-4 border border-border px-3 py-2"
            open={open}
            onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
            data-testid="plain-technical"
        >
            <summary className="cursor-pointer text-12 text-primary">
                {open ? t("mc.setup.plain.technical.hide") : t("mc.setup.plain.technical.show")}
            </summary>
            {open ? (
                <div className="mt-2 flex flex-col gap-3">
                    {channels.map((plain) => (
                        <div key={plain.channel} className="flex flex-col gap-2">
                            <div className="text-11 font-medium text-secondary uppercase">
                                {t(`mc.setup.plain.channel.${plain.channel}`)}
                            </div>
                            <FlowDiagram
                                model={flowModel(
                                    {
                                        ...draft,
                                        proposal: { ...draft.proposal, release: { [plain.channel]: plain.source } },
                                    },
                                    plain.channel,
                                    draft.options?.tagprefix || draft.facts?.tagprefix || ""
                                )}
                            />
                            <ol className="flex flex-col gap-1.5">
                                {plain.steps.map((step) => (
                                    <li
                                        key={step.n}
                                        className="flex flex-col gap-1 rounded-4 border border-border px-2 py-1.5"
                                    >
                                        <span className="text-12 text-primary">
                                            {step.n}. {stepText(t, step)}
                                        </span>
                                        {step.ids.map((id) => {
                                            const s = plain.source.find((x) => x.id === id);
                                            return (
                                                <div key={id} className="flex flex-col gap-0.5 pl-4 text-11">
                                                    <span className="text-secondary">
                                                        <code className="font-mono">{id}</code> · {s?.title}
                                                    </span>
                                                    <code className="font-mono whitespace-pre-wrap text-muted wrap-anywhere">
                                                        {s?.run ?? s?.manual}
                                                    </code>
                                                    {s?.confirm ? (
                                                        <span className="text-muted wrap-anywhere">{s.confirm}</span>
                                                    ) : null}
                                                </div>
                                            );
                                        })}
                                    </li>
                                ))}
                            </ol>
                        </div>
                    ))}
                    {sources.length > 0 ? (
                        <div className="flex flex-col gap-1">
                            <div className="text-11 font-medium text-secondary uppercase">
                                {t("mc.setup.plain.technical.sources")}
                            </div>
                            <ul className="flex flex-col gap-0.5 font-mono text-11 text-muted">
                                {sources.map(([key, s]) => (
                                    <li key={key} className="wrap-anywhere">
                                        {[key, s.path, s.detail].filter(Boolean).join(" · ")}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ) : null}
                    {children}
                </div>
            ) : null}
        </details>
    );
}

export function PlainFlowScreen({
    survey,
    draft,
    check,
    projectName,
    busy,
    onDescribe,
    onAdjust,
    onConfirm,
    canConfirm,
    question,
    questionBox,
    allChoices,
}: {
    survey: SetupSurvey;
    draft: SetupDraft;
    // The update check of a project already set up (#1102); null otherwise.
    check?: SetupCheck;
    projectName: string;
    busy?: boolean;
    onDescribe: () => void;
    onAdjust: () => void;
    onConfirm: () => void;
    canConfirm: boolean;
    // #1152's slots: a step's Question button and the screen's question box.
    question?: (step: PlainQuestionStep) => ReactNode;
    questionBox?: ReactNode;
    // "All the choices", read-only, inside the technical details.
    allChoices?: ReactNode;
}) {
    const t = useT();
    const channels = useMemo(() => plainChannels(survey, draft), [survey, draft]);
    const ctx = useMemo<PlainContext>(() => ({ draft, examples: plainExamples(survey, draft) }), [survey, draft]);
    const changes = useMemo(() => plainChanges(check, survey, draft), [check, survey, draft]);
    const trunk = draft.facts?.branches?.trunk ?? "";
    const has = (c: SetupChannel) => channels.some((p) => p.channel === c);
    const intro = has("rc") && has("public") ? "introTwo" : has("rc") ? "introRc" : "introPublic";
    return (
        <div className="@container flex flex-col gap-4" data-testid="plain-flow">
            <div className="flex flex-col gap-2">
                <SetupProgress at="understand" />
                <div className="flex flex-col gap-0.5">
                    <h2 className="text-14 font-semibold text-primary">
                        {t("mc.setup.plain.title")}
                        <span className="ml-2 text-12 font-normal text-muted">{projectName}</span>
                    </h2>
                    <p className="text-13 font-medium text-primary">{t("mc.setup.plain.headline")}</p>
                    <p className="text-12 text-secondary">
                        {t("mc.setup.plain.workBranch", { trunk })} {t(`mc.setup.plain.${intro}`)}
                    </p>
                </div>
            </div>
            {changes.length > 0 ? (
                <SectionBlock
                    title={t("mc.setup.plain.changes.title")}
                    icon={suiteIcon("updates")}
                    description={t("mc.setup.plain.changes.hint")}
                    data-testid="plain-changes"
                >
                    <ul className="flex list-disc flex-col gap-1 pt-1 pl-4">
                        {changes.map((c) => (
                            <ChangeLine key={c.key} change={c} />
                        ))}
                    </ul>
                </SectionBlock>
            ) : null}
            {channels.length === 0 ? (
                <p className="text-12 text-muted" data-testid="plain-empty">
                    {t("mc.setup.plain.empty")}
                </p>
            ) : (
                channels.map((plain) => (
                    <ChannelBlock key={plain.channel} plain={plain} ctx={ctx} question={question} />
                ))
            )}
            <TechnicalDetails channels={channels} draft={draft}>
                {allChoices}
            </TechnicalDetails>
            {questionBox}
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3" data-testid="plain-footer">
                <button
                    type="button"
                    className={SecondaryButton}
                    onClick={onDescribe}
                    disabled={busy}
                    data-testid="plain-describe"
                >
                    {t("mc.setup.plain.notIt")}
                </button>
                <span className="flex-1" />
                <button
                    type="button"
                    className={SecondaryButton}
                    onClick={onAdjust}
                    disabled={busy}
                    data-testid="plain-adjust"
                >
                    {t("mc.setup.plain.adjust")}
                </button>
                <button
                    type="button"
                    className="molten-btn cursor-pointer rounded-4 px-3 py-1.5 text-12 disabled:cursor-default disabled:opacity-50"
                    onClick={onConfirm}
                    disabled={busy || !canConfirm}
                    data-testid="plain-confirm"
                >
                    {t("mc.setup.plain.thatsIt")}
                    <MoltenWave />
                </button>
            </div>
        </div>
    );
}
