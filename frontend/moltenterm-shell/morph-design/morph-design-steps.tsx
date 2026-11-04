// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The steps of the mod design panel (FR-MORPH-019), in plain words, built with the suite's real components: a section
// block per step with its label chip, option rows for a question's choices, molten buttons for the decisions. The agent
// fills the steps through `molten morph design`; a click here is relayed to it. Every step can be skipped or done in the
// terminal, and nothing here blocks: the panel shows and relays.

import { cn } from "@/util/util";
import { useState } from "react";
import { useT } from "../i18n/i18n";
import { LearningDefaults } from "../learning/learning-model";
import { FoldedStep, PrefillMark } from "../learning/prefill-mark";
import { MoltenWave } from "../molten-button";
import { DominoLoader, OptionList, OptionRow, SectionBlock, SuiteIcon } from "../suite/suite";
import { suiteIcon, SuiteIconName } from "../suite/suite-icons";
import type { DesignActions } from "./morph-design-actions";
import {
    BusyKeys,
    decisionBusy,
    MorphDesign,
    MorphQuestion,
    MorphStepId,
    prefilledChoice,
    questionBusy,
    questionsOf,
    stepFolded,
    stepGestureBusy,
    stepHasContent,
    stepOf,
    stepView,
} from "./morph-design-model";

const PrimaryButton =
    "molten-btn inline-flex cursor-pointer items-center gap-1.5 rounded-6 px-3 py-1.5 text-12 disabled:cursor-default disabled:opacity-50";
const SecondaryButton =
    "molten-btn-secondary inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2.5 py-1 text-12 disabled:cursor-default disabled:opacity-50";
const GhostButton =
    "molten-btn-ghost inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-4 px-2 py-0.5 text-12 disabled:cursor-default disabled:opacity-50";
const DestructiveButton =
    "molten-btn molten-btn-destructive inline-flex cursor-pointer items-center gap-1.5 rounded-6 px-3 py-1.5 text-12 disabled:cursor-default disabled:opacity-50";

const StepGlyphs: Record<MorphStepId, SuiteIconName> = {
    need: "notes",
    questions: "ask",
    plan: "actions",
    preview: "display",
    adjust: "configuration",
    finish: "identity",
    validate: "verification",
    collect: "mods",
};

const iconComponents = new Map<string, SuiteIcon>();

// A Font Awesome icon as a suite icon, one component per name so a row does not remount on each render.
export function fontAwesomeIcon(name: string): SuiteIcon {
    let component = iconComponents.get(name);
    if (component == null) {
        component = ({ className }) => <i className={cn("fa fa-solid", `fa-${name}`, className)} aria-hidden />;
        iconComponents.set(name, component);
    }
    return component;
}

export type StepProps = {
    design: MorphDesign;
    defaults: LearningDefaults;
    actions: DesignActions;
    // The clicks in flight, by their own keys: only the control that was clicked waits.
    busy: BusyKeys;
    // Runs a click: the panel shows it waiting, applies the design it returns, and says what failed.
    run: (key: string, action: () => Promise<MorphDesign>) => void;
    focusTerminal: () => void;
};

function Hint({ children, testId }: { children: React.ReactNode; testId?: string }) {
    return (
        <p className="text-12 text-muted" data-testid={testId}>
            {children}
        </p>
    );
}

function Say({ text }: { text: string }) {
    if (!text) {
        return null;
    }
    return (
        <p className="text-12 break-words text-secondary" data-testid="morph-step-say">
            {text}
        </p>
    );
}

function StepStatus({ view }: { view: ReturnType<typeof stepView> }) {
    const t = useT();
    return (
        <span
            className={cn("text-11", view === "current" ? "font-medium text-accent" : "text-muted")}
            data-testid="morph-step-status"
            data-status={view}
        >
            {t(`morphDesign.state.${view}`)}
        </span>
    );
}

// The two gestures every step has: skip it, or say it is done in the terminal. A step already settled offers to take
// it back. The panel never prevents going on.
function StepControls({ id, view, ...p }: StepProps & { id: MorphStepId; view: ReturnType<typeof stepView> }) {
    const t = useT();
    const settled = view === "skipped" || view === "done" || view === "terminal";
    // A step's own gestures wait for each other, never for another step's or another control's click.
    const waiting = stepGestureBusy(p.busy, id);
    return (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="morph-step-controls">
            {settled ? (
                view === "skipped" ? (
                    <button
                        type="button"
                        className={GhostButton}
                        disabled={waiting}
                        onClick={() => p.run(`back:${id}`, () => p.actions.takeBack(id))}
                        data-testid="morph-step-back"
                    >
                        {t("morphDesign.step.back")}
                    </button>
                ) : null
            ) : (
                <>
                    <button
                        type="button"
                        className={GhostButton}
                        disabled={waiting}
                        onClick={() => p.run(`skip:${id}`, () => p.actions.skipStep(id))}
                        data-testid="morph-step-skip"
                    >
                        {p.busy.has(`skip:${id}`) ? <DominoLoader /> : null}
                        {t("morphDesign.step.skip")}
                    </button>
                    <button
                        type="button"
                        className={GhostButton}
                        disabled={waiting}
                        onClick={() => p.run(`terminal:${id}`, () => p.actions.doInTerminal(id))}
                        data-testid="morph-step-terminal"
                    >
                        {p.busy.has(`terminal:${id}`) ? <DominoLoader /> : null}
                        {t("morphDesign.step.terminal")}
                    </button>
                </>
            )}
        </div>
    );
}

function QuestionBlock({ question, ...p }: StepProps & { question: MorphQuestion }) {
    const t = useT();
    const prefilled = prefilledChoice(question, p.defaults);
    const waiting = questionBusy(p.busy, question.key);
    const name = `morph-question-${question.key}`;
    return (
        <div className="flex flex-col gap-1.5" data-testid="morph-question" data-key={question.key}>
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-12 font-medium break-words text-primary">{question.text}</span>
                {prefilled != null ? <PrefillMark /> : null}
                {waiting ? <DominoLoader /> : null}
            </div>
            {question.choices.length > 0 ? (
                <OptionList aria-label={question.text}>
                    {question.choices.map((choice) => {
                        const meta = [
                            choice.detail,
                            choice.label === question.recommended ? t("morphDesign.questions.recommended") : "",
                            choice.label === prefilled ? t("learning.prefill.mark") : "",
                        ]
                            .filter(Boolean)
                            .join(" · ");
                        return (
                            <OptionRow
                                key={choice.label}
                                name={name}
                                value={choice.label}
                                label={choice.label}
                                icon={question.kind === "icon" ? fontAwesomeIcon(choice.label) : undefined}
                                meta={meta || undefined}
                                selected={question.answer === choice.label}
                                selectedLabel={t("morphDesign.questions.selected")}
                                disabled={waiting}
                                onSelect={() =>
                                    p.run(`choose:${question.key}:${choice.label}`, () =>
                                        p.actions.choose(question, choice.label)
                                    )
                                }
                            />
                        );
                    })}
                </OptionList>
            ) : null}
            {question.answer && !question.choices.some((c) => c.label === question.answer) ? (
                <p className="text-12 break-words text-secondary" data-testid="morph-question-answer">
                    {t("morphDesign.questions.answered", { answer: question.answer })}
                    {question.answeredby === "terminal" ? ` · ${t("morphDesign.questions.inTerminal")}` : ""}
                </p>
            ) : null}
            {!question.answer ? (
                <Hint testId="morph-question-terminal">{t("morphDesign.questions.terminalHint")}</Hint>
            ) : null}
        </div>
    );
}

function QuestionsBody({ id, ...p }: StepProps & { id: "questions" | "finish" }) {
    const t = useT();
    const questions = questionsOf(p.design, id);
    if (questions.length === 0) {
        return <Hint testId="morph-step-empty">{t(`morphDesign.step.${id}.empty`)}</Hint>;
    }
    return (
        <div className="flex flex-col gap-4">
            {questions.map((q) => (
                <QuestionBlock key={q.key} question={q} {...p} />
            ))}
        </div>
    );
}

function PlanList({ title, items, testId }: { title: string; items: string[]; testId: string }) {
    return (
        <div className="flex flex-col gap-0.5" data-testid={testId}>
            <span className="text-11 font-medium tracking-wide text-muted uppercase">{title}</span>
            <ul className="flex list-disc flex-col gap-0.5 pl-4 text-12 text-primary">
                {items.map((item, i) => (
                    <li key={i} className="break-words">
                        {item}
                    </li>
                ))}
            </ul>
        </div>
    );
}

function PlanBody(p: StepProps) {
    const t = useT();
    const plan = p.design.plan;
    if (plan == null) {
        return <Hint testId="morph-step-empty">{t("morphDesign.step.plan.empty")}</Hint>;
    }
    return (
        <div className="flex flex-col gap-3" data-testid="morph-plan">
            <p className="text-12 break-words text-primary" data-testid="morph-plan-summary">
                {plan.summary}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
                {plan.moltenpart.length > 0 ? (
                    <PlanList
                        title={t("morphDesign.plan.moltenPart")}
                        items={plan.moltenpart}
                        testId="morph-plan-molten"
                    />
                ) : null}
                {plan.agentpart.length > 0 ? (
                    <PlanList
                        title={t("morphDesign.plan.agentPart")}
                        items={plan.agentpart}
                        testId="morph-plan-agent"
                    />
                ) : null}
            </div>
            <PlanList
                title={t("morphDesign.plan.accesses")}
                items={plan.accesses.length > 0 ? plan.accesses : [t("morphDesign.plan.nothingElse")]}
                testId="morph-plan-accesses"
            />
            {plan.waits.length > 0 ? (
                <PlanList title={t("morphDesign.plan.waits")} items={plan.waits} testId="morph-plan-waits" />
            ) : null}
            <Hint testId="morph-plan-trust">{t("morphDesign.plan.trust")}</Hint>
            {plan.agreed ? (
                <p className="text-12 font-medium text-primary" data-testid="morph-plan-agreed">
                    {t("morphDesign.plan.agreed")}
                </p>
            ) : (
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        className={PrimaryButton}
                        disabled={p.busy.has("agree")}
                        onClick={() => p.run("agree", () => p.actions.agree())}
                        data-testid="morph-plan-agree"
                    >
                        {p.busy.has("agree") ? <DominoLoader /> : null}
                        {t("morphDesign.plan.agree")}
                        <MoltenWave />
                    </button>
                    <button
                        type="button"
                        className={SecondaryButton}
                        onClick={p.focusTerminal}
                        data-testid="morph-plan-change"
                    >
                        {t("morphDesign.plan.change")}
                    </button>
                </div>
            )}
        </div>
    );
}

function Chips({ title, items, testId }: { title: string; items: string[]; testId: string }) {
    if (items.length === 0) {
        return null;
    }
    return (
        <div className="flex flex-wrap items-center gap-1.5" data-testid={testId}>
            <span className="text-11 font-medium tracking-wide text-muted uppercase">{title}</span>
            {items.map((item) => (
                <span
                    key={item}
                    className="rounded-4 border border-border px-1.5 py-0.5 font-mono text-11 text-primary"
                >
                    {item}
                </span>
            ))}
        </div>
    );
}

// What API version 1 draws until the declarative panel (FR-MORPH-020, story #1890) draws the mod itself.
function PreviewBody({ design }: StepProps) {
    const t = useT();
    const draft = design.draft;
    const shown = draft.state !== "none" || draft.commands.length > 0 || draft.boxes.length > 0;
    return (
        <div className="flex flex-col gap-3" data-testid="morph-preview">
            {shown ? (
                <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-4 border border-border px-1.5 py-0.5 text-10 font-medium tracking-wide text-secondary uppercase">
                            {t("morphDesign.preview.draft")}
                        </span>
                        <span className="text-12 text-muted" data-testid="morph-preview-data">
                            {t(draft.state === "real" ? "morphDesign.preview.real" : "morphDesign.preview.sample")}
                        </span>
                    </div>
                    {draft.note ? <Say text={draft.note} /> : null}
                    <Chips
                        title={t("morphDesign.preview.commands")}
                        items={draft.commands}
                        testId="morph-preview-commands"
                    />
                    <Chips title={t("morphDesign.preview.boxes")} items={draft.boxes} testId="morph-preview-boxes" />
                </div>
            ) : (
                <Hint testId="morph-step-empty">{t("morphDesign.step.preview.empty")}</Hint>
            )}
            <div
                className="flex items-center gap-3 rounded-4 border border-dashed border-border px-3 py-3 text-12 text-muted"
                data-testid="morph-preview-placeholder"
            >
                <i className="fa fa-solid fa-window-restore text-14" aria-hidden />
                <span className="min-w-0 flex-1">{t("morphDesign.preview.placeholder")}</span>
                <span className="shrink-0 text-11 font-medium text-secondary">{t("morphDesign.soon")}</span>
            </div>
        </div>
    );
}

function ValidateBody(p: StepProps) {
    const t = useT();
    const [confirming, setConfirming] = useState(false);
    const outcome = p.design.outcome;
    if (outcome === "validated") {
        return (
            <p className="text-12 font-medium text-primary" data-testid="morph-validated">
                {t("morphDesign.validate.validated")}
            </p>
        );
    }
    if (outcome === "gaveup") {
        return (
            <p className="text-12 font-medium text-primary" data-testid="morph-gaveup">
                {t("morphDesign.validate.gaveUp")}
            </p>
        );
    }
    return (
        <div className="flex flex-col gap-3">
            <Hint testId="morph-step-empty">{t("morphDesign.step.validate.empty")}</Hint>
            {confirming ? (
                <div className="flex flex-wrap items-center gap-2" role="alert" data-testid="morph-giveup-confirm">
                    <span className="min-w-0 flex-1 basis-60 text-12 text-secondary">
                        {t("morphDesign.validate.confirm")}
                    </span>
                    <button
                        type="button"
                        className={DestructiveButton}
                        disabled={decisionBusy(p.busy)}
                        onClick={() => p.run("giveup", () => p.actions.giveUp())}
                        data-testid="morph-giveup-yes"
                    >
                        {p.busy.has("giveup") ? <DominoLoader /> : null}
                        {t("morphDesign.validate.giveUp")}
                    </button>
                    <button type="button" className={GhostButton} onClick={() => setConfirming(false)}>
                        {t("morphDesign.validate.keep")}
                    </button>
                </div>
            ) : (
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        className={PrimaryButton}
                        disabled={decisionBusy(p.busy)}
                        onClick={() => p.run("validate", () => p.actions.validate())}
                        data-testid="morph-validate"
                    >
                        {p.busy.has("validate") ? <DominoLoader /> : null}
                        {t("morphDesign.validate.validate")}
                        <MoltenWave />
                    </button>
                    <button
                        type="button"
                        className={SecondaryButton}
                        disabled={decisionBusy(p.busy)}
                        onClick={() => setConfirming(true)}
                        data-testid="morph-giveup"
                    >
                        {t("morphDesign.validate.giveUp")}
                    </button>
                </div>
            )}
        </div>
    );
}

// Where the mod will live: Your mods is story #1895, so the step says it is coming and the agent says where the mod is.
function CollectBody() {
    const t = useT();
    return (
        <div
            className="flex items-center gap-3 rounded-4 border border-dashed border-border px-3 py-3 text-12 text-muted"
            data-testid="morph-collect-placeholder"
        >
            <i className="fa fa-solid fa-puzzle-piece text-14" aria-hidden />
            <span className="min-w-0 flex-1">{t("morphDesign.collect.soon")}</span>
            <span className="shrink-0 text-11 font-medium text-secondary">{t("morphDesign.soon")}</span>
        </div>
    );
}

function StepBody({ id, ...p }: StepProps & { id: MorphStepId }) {
    const t = useT();
    switch (id) {
        case "questions":
        case "finish":
            return (
                <>
                    <QuestionsBody id={id} {...p} />
                    {id === "finish" ? (
                        <Hint testId="morph-finish-soon">{t("morphDesign.step.finish.soon")}</Hint>
                    ) : null}
                </>
            );
        case "plan":
            return <PlanBody {...p} />;
        case "preview":
            return <PreviewBody {...p} />;
        case "validate":
            return <ValidateBody {...p} />;
        case "collect":
            return <CollectBody />;
        default:
            return stepHasContent(p.design, id) ? null : (
                <Hint testId="morph-step-empty">{t(`morphDesign.step.${id}.empty`)}</Hint>
            );
    }
}

// One step: its section block with the label chip and the turning light when it is the current one; folded to a calm
// row when the developer always skips it (the step is still there, one click away).
export function StepBlock({ id, ...p }: StepProps & { id: MorphStepId }) {
    const t = useT();
    const view = stepView(p.design, id);
    const title = t(`morphDesign.step.${id}.title`);
    const body = (
        <SectionBlock
            title={title}
            icon={suiteIcon(StepGlyphs[id])}
            description={t(`morphDesign.step.${id}.hint`)}
            glow={view === "current"}
            className={view === "skipped" ? "opacity-70" : undefined}
            data-testid={`morph-step-${id}`}
            data-step={id}
            data-status={view}
        >
            <div className="flex flex-col gap-3 pt-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <StepStatus view={view} />
                    <StepControls id={id} view={view} {...p} />
                </div>
                <Say text={stepOf(p.design, id).say ?? ""} />
                {view === "skipped" ? null : <StepBody id={id} {...p} />}
            </div>
        </SectionBlock>
    );
    return (
        <FoldedStep folded={stepFolded(p.design, p.defaults, id)} title={title} testId={`morph-folded-${id}`}>
            {body}
        </FoldedStep>
    );
}
