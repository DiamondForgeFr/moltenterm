// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Help me choose (FR-ONB-008 AC-6 to AC-9): the questions and the suggestions, one component for the Library's Agents
// section and the first launch's agents scene, so both ask the same questions and apply the same rules
// (agents-model.ts). Each surface brings its look, its test ids and what a suggestion leads to.

import { useState } from "react";
import { useT, useTCount } from "../i18n/i18n";
import { SidebarGlyph } from "../sidebar/sidebar-icons";
import {
    chooseAgents,
    ChooseBudgets,
    ChooseGoals,
    ChooseNone,
    ChooseQuestionCount,
    ChooseSubscriptions,
    priceText,
    type ChooseAnswers,
    type ChooseState,
    type ChooseSuggestion,
    type LibraryAgent,
} from "./agents-model";

export type ChooseLook = { answer: string; link: string; cards: string; card: string; list: string; icon: string };

export const LibraryChooseLook: ChooseLook = {
    answer: "mt-lib-btn",
    link: "mt-lib-link",
    cards: "mt-lib-pcards",
    card: "mt-lib-pcard",
    list: "mt-lib-aglist",
    icon: "mt-lib-pic",
};

type Answer = { id: string; label: string; answers: ChooseAnswers };

function ChooseQuestion({
    state,
    look,
    testId,
    onAnswer,
    onBack,
}: {
    state: ChooseState;
    look: ChooseLook;
    testId: string;
    onAnswer: (answers: ChooseAnswers) => void;
    onBack: () => void;
}) {
    const t = useT();
    const step = state.step;
    let question: string;
    let answers: Answer[];
    if (step === 0) {
        question = t("library.agents.choose.goal.question");
        answers = ChooseGoals.map((g) => ({
            id: g,
            label: t(`library.agents.choose.goal.answers.${g}`),
            answers: { goal: g },
        }));
    } else if (step === 1) {
        question = t("library.agents.choose.budget.question");
        answers = ChooseBudgets.map((b) => ({
            id: b,
            label: t(`library.agents.choose.budget.answers.${b}`),
            answers: { budget: b },
        }));
    } else {
        question = t("library.agents.choose.already.question");
        answers = [
            ...ChooseSubscriptions.map((s) => ({ id: s.id, label: s.label, answers: { already: s.id } })),
            { id: ChooseNone, label: t("library.agents.choose.already.answers.none"), answers: { already: ChooseNone } },
        ];
    }
    return (
        <div className="flex flex-col gap-2" data-testid={`${testId}-question`} data-step={step}>
            <span className="text-11 text-secondary">{t("library.agents.choose.step", { n: String(step + 1) })}</span>
            <b className="text-14 text-primary">{question}</b>
            <div className="flex flex-wrap gap-1.5">
                {answers.map((a) => (
                    <button
                        key={a.id}
                        type="button"
                        className={`${look.answer} cursor-pointer`}
                        data-testid={`${testId}-answer`}
                        data-answer={a.id}
                        onClick={() => onAnswer(a.answers)}
                    >
                        {a.label}
                    </button>
                ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
                {step > 0 ? (
                    <button type="button" className={`${look.link} cursor-pointer`} onClick={onBack}>
                        {t("library.agents.choose.back")}
                    </button>
                ) : null}
                <button
                    type="button"
                    className={`${look.link} cursor-pointer`}
                    data-testid={`${testId}-skip`}
                    onClick={() => onAnswer({})}
                >
                    {t("library.agents.choose.skip")}
                </button>
            </div>
        </div>
    );
}

function ChooseCard({
    suggestion,
    look,
    testId,
    action,
}: {
    suggestion: ChooseSuggestion;
    look: ChooseLook;
    testId: string;
    action?: (row: LibraryAgent) => React.ReactNode;
}) {
    const t = useT();
    const { row, reasons } = suggestion;
    return (
        <div className={look.card} data-testid={`${testId}-suggestion`} data-agent={row.card.id}>
            <div className="flex items-center gap-2 font-semibold text-primary">
                <i className={look.icon} aria-hidden>
                    <SidebarGlyph name="agents" size={16} />
                </i>
                <span className="truncate">{row.card.name}</span>
            </div>
            <ul className={look.list}>
                {reasons.map((r) => (
                    <li key={r.key}>{t(r.key, r.vars)}</li>
                ))}
            </ul>
            <span className="text-11 text-secondary">{priceText(t, row.agent.profile)}</span>
            {action?.(row)}
        </div>
    );
}

function ChooseResults({
    rows,
    state,
    look,
    testId,
    action,
    endActions,
    onBack,
    onRestart,
}: {
    rows: LibraryAgent[];
    state: ChooseState;
    look: ChooseLook;
    testId: string;
    action?: (row: LibraryAgent) => React.ReactNode;
    endActions?: React.ReactNode;
    onBack: () => void;
    onRestart: () => void;
}) {
    const t = useT();
    const tc = useTCount();
    const [showOthers, setShowOthers] = useState(false);
    const result = chooseAgents(rows, state.answers, state.seed);
    const names = result.shown.map((s) => s.row.card.name);
    const card = (s: ChooseSuggestion) => (
        <ChooseCard key={s.row.card.id} suggestion={s} look={look} testId={testId} action={action} />
    );
    return (
        <div className="flex flex-col gap-3" data-testid={`${testId}-results`}>
            {result.shown.length === 0 ? (
                <p data-testid={`${testId}-none`}>{t("library.agents.choose.noneMatch")}</p>
            ) : (
                <div className={look.cards}>{result.shown.map(card)}</div>
            )}
            {result.others.length > 0 && !showOthers ? (
                <button
                    type="button"
                    className={`${look.link} cursor-pointer self-start`}
                    data-testid={`${testId}-others`}
                    onClick={() => setShowOthers(true)}
                >
                    {tc("library.agents.choose.otherMatches", result.others.length)}
                </button>
            ) : null}
            {showOthers ? <div className={look.cards}>{result.others.map(card)}</div> : null}
            {names.length > 0 ? (
                <p data-testid={`${testId}-combine`}>
                    {names.length === 2
                        ? t("library.agents.choose.combine.two", { a: names[0], b: names[1] })
                        : t("library.agents.choose.combine.one")}
                </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
                {endActions}
                <button type="button" className={`${look.link} cursor-pointer`} onClick={onBack}>
                    {t("library.agents.choose.back")}
                </button>
                <button
                    type="button"
                    className={`${look.link} cursor-pointer`}
                    data-testid={`${testId}-again`}
                    onClick={onRestart}
                >
                    {t("library.agents.choose.again")}
                </button>
            </div>
        </div>
    );
}

// The questions one at a time, then the suggestions; the caller keeps the state (an atom in the Library, the scene's
// own state on the first launch).
export function ChoosePath({
    rows,
    state,
    look,
    testId,
    action,
    endActions,
    onAnswer,
    onBack,
    onRestart,
}: {
    rows: LibraryAgent[];
    state: ChooseState;
    look: ChooseLook;
    testId: string;
    action?: (row: LibraryAgent) => React.ReactNode;
    endActions?: React.ReactNode;
    onAnswer: (answers: ChooseAnswers) => void;
    onBack: () => void;
    onRestart: () => void;
}) {
    if (state.step < ChooseQuestionCount) {
        return <ChooseQuestion state={state} look={look} testId={testId} onAnswer={onAnswer} onBack={onBack} />;
    }
    return (
        <ChooseResults
            key={state.seed}
            rows={rows}
            state={state}
            look={look}
            testId={testId}
            action={action}
            endActions={endActions}
            onBack={onBack}
            onRestart={onRestart}
        />
    );
}
