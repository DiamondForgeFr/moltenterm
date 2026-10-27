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
import { flowClass, MotionClass, useFlowList, useGlowPass } from "../molten-motion";
import { SectionBlock } from "../suite/suite";
import { suiteIcon } from "../suite/suite-icons";
import { BoardCards, BoardSection, SetupBoard } from "./release-setup-board";
import {
    baseDraft,
    BoardItem,
    BoardMarkOp,
    channelItems,
    copyTarget,
    generalItems,
    itemByKey,
    previewDraft,
    saidOf,
    saidSteps,
    stepMarks,
} from "./release-setup-board-model";
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
    validate: "warning",
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

const MarkTone: Record<BoardMarkOp, PillTone> = { add: "warning", change: "warning", remove: "danger" };

// The setup agent's open proposal on a step, decided on the step itself (FR-MC-045): what it read before, the agent's
// name and reason, Accept and Decline, and "apply to the other version too" when that version has the same step.
export type StepProposal = {
    item: BoardItem;
    before?: { text: string; who: PlainWho };
    busy?: boolean;
    copyTo?: SetupChannel;
    onDecide: (accept: boolean) => void;
    onCopy?: () => void;
};

function ProposalOnStep({ proposal, op }: { proposal: StepProposal; op: BoardMarkOp }) {
    const t = useT();
    const { item } = proposal;
    const stop = (e: React.MouseEvent) => e.stopPropagation();
    return (
        <span className="mt-1.5 flex flex-col gap-1.5" onClick={stop} data-testid="plain-step-proposal">
            <span className="text-11">
                <span className="font-medium text-accent">
                    {item.by ? t("mc.setup.board.proposedBy", { name: item.by }) : t("mc.setup.board.proposedByAgent")}
                </span>
                {item.why ? <span className="text-secondary"> · {item.why}</span> : null}
            </span>
            <span className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    className="molten-btn cursor-pointer rounded-4 px-2.5 py-1 text-11 disabled:cursor-default disabled:opacity-50"
                    disabled={proposal.busy}
                    onClick={() => proposal.onDecide(true)}
                    data-testid="board-accept"
                >
                    {op === "remove" ? t("mc.setup.board.acceptRemove") : t("mc.setup.board.accept")}
                    <MoltenWave />
                </button>
                <button
                    type="button"
                    className="cursor-pointer rounded-4 border border-border px-2.5 py-1 text-11 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50"
                    disabled={proposal.busy}
                    onClick={() => proposal.onDecide(false)}
                    data-testid="board-decline"
                >
                    {t("mc.setup.board.decline")}
                </button>
                {proposal.copyTo ? (
                    <button
                        type="button"
                        className="cursor-pointer rounded-4 px-1.5 py-1 text-11 text-accent hover:underline disabled:cursor-default disabled:opacity-50"
                        disabled={proposal.busy}
                        onClick={proposal.onCopy}
                        data-testid="board-copy"
                    >
                        {t(`mc.setup.board.copyTo.${proposal.copyTo}`)}
                    </button>
                ) : null}
            </span>
        </span>
    );
}

function StepRow({
    step,
    text,
    who,
    lit,
    picked,
    onHover,
    onPick,
    question,
    mark,
    proposal,
    explaining,
    className,
}: {
    step: PlainStep;
    text: string;
    // Who does it as shown: the model's, or the setup agent's words for a step it proposed.
    who: PlainWho;
    lit: boolean;
    picked: boolean;
    onHover: (n: number) => void;
    onPick: (n: number) => void;
    question?: ReactNode;
    // The setup agent's open proposal on this step, and its explanation of it (FR-MC-045).
    mark?: BoardMarkOp;
    proposal?: StepProposal;
    explaining?: { by?: string; note?: string };
    className?: string;
}) {
    const t = useT();
    const glow = useGlowPass(`${mark ?? ""}|${text}|${who}`);
    const before = mark === "change" ? proposal?.before : null;
    const changed = before != null && (before.text !== text || before.who !== who);
    return (
        <div
            className={cn(
                "flex cursor-pointer flex-wrap items-start gap-x-2.5 gap-y-1 rounded-4 border px-2.5 py-2 transition-colors duration-120",
                lit ? "border-accent/60 bg-accent/10" : "border-transparent hover:bg-hover",
                mark ? "border-dashed border-accent/70" : null,
                explaining ? MotionClass.glow : null,
                glow,
                className
            )}
            data-mark={mark}
            data-explaining={explaining ? "" : undefined}
            onMouseEnter={() => onHover(step.n)}
            onMouseLeave={() => onHover(null)}
            onClick={() => onPick(step.n)}
            role="button"
            aria-pressed={picked}
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
                {changed ? (
                    <span className="mb-1 flex flex-wrap items-center gap-1.5" data-testid="plain-step-before">
                        <span className="text-muted line-through">{before.text}</span>
                        {before.who !== who ? (
                            <span className="text-11 text-muted line-through">
                                {t(`mc.setup.plain.who.${before.who}`)}
                            </span>
                        ) : null}
                    </span>
                ) : null}
                <span className={cn(mark === "remove" ? "text-muted line-through" : null)} data-testid="plain-step-now">
                    {text}
                </span>
                {proposal && mark ? <ProposalOnStep proposal={proposal} op={mark} /> : null}
                {explaining ? (
                    <span className="mt-1 block text-11 text-accent" data-testid="plain-step-explaining">
                        {explaining.by
                            ? t("mc.setup.board.explaining", { name: explaining.by })
                            : t("mc.setup.board.explainingAgent")}
                        {explaining.note ? <span className="text-secondary"> · {explaining.note}</span> : null}
                    </span>
                ) : null}
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
                {mark ? (
                    <Pill label={t(`mc.setup.board.mark.${mark}`)} tone={MarkTone[mark]} testId="plain-step-mark" />
                ) : null}
                {question}
                <Pill
                    label={t(`mc.setup.plain.who.${who}`)}
                    tone={WhoTone[who]}
                    dot={who === "molten"}
                    testId="plain-step-who"
                />
                {step.ifNeeded ? <Pill label={t("mc.setup.plain.ifNeeded")} /> : null}
                {step.yours ? <Pill label={t("mc.setup.plain.yours")} testId="plain-step-yours" /> : null}
            </span>
        </div>
    );
}

const stepKey = (step: PlainStep) => step.ids.join("+");

function ChannelBlock({
    plain,
    ctx,
    question,
    board,
    before,
    channels,
}: {
    plain: PlainChannel;
    ctx: PlainContext;
    question?: (step: PlainQuestionStep) => ReactNode;
    board?: SetupBoard;
    // The channel as it reads before the open proposals: a change's "before".
    before?: PlainChannel;
    // Every channel shown, for "apply to the other version too".
    channels?: PlainChannel[];
}) {
    const t = useT();
    const [hover, setHover] = useState<number>(null);
    const [picked, setPicked] = useState<number>(null);
    const lit = hover ?? picked;
    const state = board?.state;
    const marks = useMemo(() => stepMarks(plain, state), [plain, state]);
    const explain = state?.explain?.channel === plain.channel ? state.explain : null;
    // By the step's ids: a step added before it moves its number.
    const numberOf = (ids: string[], fallback?: number) =>
        plain.steps.find((s) => s.ids.some((id) => ids?.includes(id)))?.n ?? fallback;
    const explainN = explain == null ? null : numberOf(explain.ids, explain.n);
    const flagNumber = (ref: string) => numberOf([ref.split("/")[1]]);
    const model = useMemo(() => {
        const base = plainFlowModel(plain, ctx, t);
        if (marks.size === 0 && explain == null) {
            return base;
        }
        return {
            ...base,
            nodes: base.nodes.map((n) => ({
                ...n,
                proposed: n.badge != null ? marks.get(n.badge)?.op : undefined,
                explained: explainN != null && n.badge === explainN,
            })),
        };
    }, [plain, ctx, t, marks, explain, explainN]);
    const rows = useFlowList(plain.steps, stepKey);
    const said = useMemo(() => saidSteps(state), [state]);
    // A step change is decided on its step; the cards keep the flags and what no step shows.
    const items = useMemo(() => {
        const inline = new Set([...marks.values()].map((m) => m.key));
        return channelItems(state, plain.channel).filter((it) => !inline.has(it.key));
    }, [state, plain.channel, marks]);
    const beforeOf = (step: PlainStep): { text: string; who: PlainWho } => {
        const old = before?.steps.find((s) => s.ids.some((id) => step.ids.includes(id)));
        return old == null ? null : { text: stepText(t, old), who: old.who };
    };
    const proposalOf = (step: PlainStep): StepProposal => {
        const mark = marks.get(step.n);
        const item = mark == null ? null : itemByKey(state, mark.key);
        if (item == null || board == null) {
            return null;
        }
        return {
            item,
            before: beforeOf(step),
            busy: board.busy === item.key,
            copyTo: copyTarget(item, state, channels),
            onDecide: (accept) => board.decide(item.key, accept),
            onCopy: () => board.copy(item.key),
        };
    };
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
                <ol className="flex flex-col">
                    {rows.map(({ key, item: step, phase }) => {
                        const words = saidOf(said, plain.channel, step);
                        const text = words?.say || stepText(t, step);
                        const who = words?.who || step.who;
                        const exiting = phase === "exit";
                        return (
                            <li key={key} className={cn("pb-0.5", flowClass(phase))} data-phase={phase}>
                                <div>
                                    <StepRow
                                        step={step}
                                        text={text}
                                        who={who}
                                        proposal={exiting ? null : proposalOf(step)}
                                        lit={!exiting && lit === step.n}
                                        picked={!exiting && picked === step.n}
                                        onHover={exiting ? () => {} : setHover}
                                        onPick={exiting ? () => {} : pick}
                                        mark={exiting ? undefined : marks.get(step.n)?.op}
                                        explaining={!exiting && explainN === step.n ? explain : undefined}
                                        question={
                                            exiting
                                                ? null
                                                : question?.({
                                                      channel: plain.channel,
                                                      number: step.n,
                                                      kind: step.topic,
                                                      text,
                                                  })
                                        }
                                    />
                                </div>
                            </li>
                        );
                    })}
                </ol>
                {board ? (
                    <BoardCards
                        items={items}
                        board={board}
                        testId={`board-cards-${plain.channel}`}
                        stepNumber={flagNumber}
                    />
                ) : null}
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
    board,
    progress,
}: {
    survey: SetupSurvey;
    draft: SetupDraft;
    // The terminal agent's board (FR-MC-045): its proposals show in place, live.
    board?: SetupBoard;
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
    // The setup's progression (#1163); the three plain markers when the screen stands alone.
    progress?: ReactNode;
}) {
    const t = useT();
    const boardState = board?.state;
    const shown = useMemo(() => previewDraft(draft, boardState), [draft, boardState]);
    const channels = useMemo(() => plainChannels(survey, shown), [survey, shown]);
    const ctx = useMemo<PlainContext>(
        () => ({ draft: shown, examples: plainExamples(survey, shown) }),
        [survey, shown]
    );
    const general = useMemo(() => generalItems(boardState), [boardState]);
    const beforeChannels = useMemo(
        () => (boardState == null ? [] : plainChannels(survey, baseDraft(draft, boardState))),
        [survey, draft, boardState]
    );
    const changes = useMemo(() => plainChanges(check, survey, draft), [check, survey, draft]);
    const trunk = draft.facts?.branches?.trunk ?? "";
    const has = (c: SetupChannel) => channels.some((p) => p.channel === c);
    const intro = has("rc") && has("public") ? "introTwo" : has("rc") ? "introRc" : "introPublic";
    return (
        <div className="@container flex flex-col gap-4" data-testid="plain-flow">
            <div className="flex flex-col gap-2">
                {progress === undefined ? <SetupProgress at="understand" /> : progress}
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
                    <ChannelBlock
                        key={plain.channel}
                        plain={plain}
                        ctx={ctx}
                        question={question}
                        board={board}
                        before={beforeChannels.find((c) => c.channel === plain.channel)}
                        channels={channels}
                    />
                ))
            )}
            {board ? <BoardSection board={board} items={general} /> : null}
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
