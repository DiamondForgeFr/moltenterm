// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Step 2a of the deployment pipeline setup (FR-MC-040): the existing pipeline drawn, and "What we understood" beside
// it, each point with where it was read, confirmed or adjusted; a point to confirm keeps Next disabled. A node and its
// point select each other; the diagram follows the answers.

import { cn } from "@/util/util";
import { useState } from "react";
import { useT, useTCount } from "../i18n/i18n";
import {
    AnalysisPoint,
    answerOf,
    existingFlowModel,
    existingSaasModel,
    PointAnswers,
    pointNumbers,
    PointSource,
    PointText,
} from "./release-setup-analyse-model";
import { FlowDiagram } from "./release-setup-diagram";
import type { SetupChannel, SetupChoice, SetupDraft } from "./release-setup-model";
import type { SetupSurvey } from "./release-setup-stepper";

const BlockClass = "flex min-w-0 flex-col gap-2 rounded-6 border border-border p-3";
const ChipClass = "self-start rounded-4 border border-border px-1.5 py-0.5 text-10 tracking-wide text-muted uppercase";
const SmallButton =
    "cursor-pointer rounded-4 border border-border px-2 py-0.5 text-11 text-secondary hover:bg-hover hover:text-primary";

function usePointText() {
    const t = useT();
    const tCount = useTCount();
    return (text: PointText) => {
        const key = `mc.setup.analyse.point.${text.key}`;
        return text.count != null ? tCount(key, text.count, text.vars) : t(key, text.vars);
    };
}

function useChoiceLabel() {
    const t = useT();
    return (point: AnalysisPoint, draft: SetupDraft, id: string): string => {
        const facts = draft.facts;
        switch (point.kind) {
            case "merge":
                return t(`mc.setup.merge.${id}`);
            case "protection":
                return t(`mc.setup.analyse.choice.protection.${id}`, { release: facts.branches.release });
        }
        return t(`mc.setup.analyse.choice.${point.kind}.${id}`);
    };
}

function sourceText(t: (key: string, vars?: Record<string, string | number>) => string, s: PointSource): string {
    return s.key ? t(`mc.setup.analyse.source.${s.key}`, s.vars) : (s.text ?? "");
}

function ChoiceOption({
    choice,
    label,
    selected,
    asRead,
    onSelect,
}: {
    choice: SetupChoice;
    label: string;
    selected: boolean;
    asRead: boolean;
    onSelect: () => void;
}) {
    const t = useT();
    return (
        <button
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={!choice.allowed}
            onClick={onSelect}
            className={cn(
                "flex w-full items-start gap-2 rounded-4 border px-2.5 py-1.5 text-left transition-colors duration-120 ease-mt",
                choice.allowed ? "cursor-pointer" : "cursor-default opacity-60",
                selected ? "border-accent/60 bg-accent/10" : "border-border hover:border-secondary/40"
            )}
            data-testid={`setup-adjust-${choice.id}`}
        >
            <span
                className={cn(
                    "mt-[3px] h-3 w-3 shrink-0 rounded-full border",
                    selected ? "border-accent bg-accent" : "border-secondary/60"
                )}
            />
            <span className="flex min-w-0 flex-1 flex-col wrap-anywhere">
                <span className="text-12 font-medium text-primary">{label}</span>
                {(choice.reasons ?? []).map((reason) => (
                    <span key={reason.code} className={cn("text-11", reason.refuses ? "text-warning" : "text-muted")}>
                        {t(`mc.setup.reason.${reason.code}`, { target: reason.target ?? "" })}
                    </span>
                ))}
            </span>
            {asRead ? (
                <span className="shrink-0 rounded-4 border border-accent/50 px-1.5 text-10 text-accent">
                    {t("mc.setup.analyse.asRead")}
                </span>
            ) : null}
        </button>
    );
}

function PointRow({
    point,
    number,
    draft,
    answers,
    selected,
    onSelect,
    onAnswer,
}: {
    point: AnalysisPoint;
    number: number;
    draft: SetupDraft;
    answers: PointAnswers;
    selected: boolean;
    onSelect: () => void;
    onAnswer: (value: string) => void;
}) {
    const t = useT();
    const text = usePointText();
    const choiceLabel = useChoiceLabel();
    const answered = answers?.[point.key];
    const current = answerOf(point, answers);
    const adjusted = answered != null && answered !== point.selected;
    const pending = point.confirm && answered == null;
    return (
        <li
            className={cn(
                "flex flex-col gap-1 rounded-4 border px-2.5 py-2",
                selected ? "border-accent/60 bg-accent/5" : pending ? "border-warning/40" : "border-border"
            )}
            data-testid={`setup-point-${point.key}`}
        >
            <div className="flex items-start gap-2">
                <button
                    type="button"
                    onClick={onSelect}
                    className={cn(
                        "mt-[1px] inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full font-mono text-11 font-semibold",
                        pending ? "bg-warning text-background" : "bg-accent/80 text-background"
                    )}
                    aria-label={t("mc.setup.analyse.selectPoint", { n: number })}
                >
                    {number}
                </button>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 wrap-anywhere">
                    <span className="text-12 text-primary">
                        {text(point.text)}
                        {point.extras.map((e, i) => (
                            <span key={i}> {text(e)}</span>
                        ))}
                    </span>
                    {point.sources.length > 0 ? (
                        <span className="font-mono text-11 text-muted">
                            {point.sources.map((s) => sourceText(t, s)).join(" · ")}
                        </span>
                    ) : null}
                    {adjusted ? (
                        <span className="text-11 text-accent">
                            {t("mc.setup.analyse.yourAnswer", { answer: choiceLabel(point, draft, current) })}
                        </span>
                    ) : null}
                </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pl-7">
                {pending ? (
                    <span className="rounded-full border border-warning/60 px-1.5 text-10 leading-4 text-warning">
                        {t("mc.setup.analyse.toConfirm")}
                    </span>
                ) : answered != null && !adjusted ? (
                    <span className="rounded-full border border-success/60 px-1.5 text-10 leading-4 text-success">
                        {t("mc.setup.analyse.confirmed")}
                    </span>
                ) : null}
                {point.confirm ? (
                    point.choices.map((c) => (
                        <button
                            key={c.id}
                            type="button"
                            disabled={!c.allowed}
                            onClick={() => onAnswer(c.id)}
                            className={cn(
                                SmallButton,
                                answered === c.id && "border-accent/60 text-primary",
                                !c.allowed && "cursor-default opacity-50"
                            )}
                            data-testid={`setup-answer-${point.key}-${c.id}`}
                        >
                            {choiceLabel(point, draft, c.id)}
                        </button>
                    ))
                ) : (
                    <>
                        {answered == null ? (
                            <button
                                type="button"
                                onClick={() => onAnswer(point.selected)}
                                className={SmallButton}
                                data-testid={`setup-correct-${point.key}`}
                            >
                                {t("mc.setup.analyse.correct")}
                            </button>
                        ) : null}
                        {point.choices.length > 1 ? (
                            <button
                                type="button"
                                onClick={onSelect}
                                className={SmallButton}
                                data-testid={`setup-adjust-${point.key}`}
                            >
                                {t("mc.setup.analyse.adjust")}
                            </button>
                        ) : null}
                    </>
                )}
            </div>
        </li>
    );
}

export function AnalyseStep({
    survey,
    draft,
    points,
    answers,
    onAnswer,
}: {
    survey: SetupSurvey;
    draft: SetupDraft;
    points: AnalysisPoint[];
    answers: PointAnswers;
    onAnswer: (key: string, value: string) => void;
}) {
    const t = useT();
    const choiceLabel = useChoiceLabel();
    const [channel, setChannel] = useState<SetupChannel>("public");
    const [selected, setSelected] = useState<string>(null);
    const numbers = pointNumbers(points);
    const saas = draft.options.kind === "saas";
    const rcPoint = points.find((p) => p.kind === "rc");
    const rcShown =
        !saas && (rcPoint == null ? !draft.facts.missing.includes("rc") : answerOf(rcPoint, answers) === "keep");
    const shown: SetupChannel = rcShown ? channel : "public";
    const model = saas
        ? existingSaasModel(draft, points, answers)
        : existingFlowModel(survey, draft, points, answers, shown, t);
    const point = points.find((p) => p.key === selected);
    const adjustable = point != null && point.choices.length > 1;
    return (
        <div className="flex flex-col gap-3" data-testid="setup-analyse">
            {saas ? null : (
                <div className="flex gap-1" role="tablist">
                    {(["public", "rc"] as SetupChannel[]).map((c) => (
                        <button
                            key={c}
                            type="button"
                            role="tab"
                            aria-selected={shown === c}
                            disabled={c === "rc" && !rcShown}
                            onClick={() => setChannel(c)}
                            className={cn(
                                "cursor-pointer rounded-4 border px-3 py-1 text-11 disabled:cursor-default disabled:opacity-50",
                                shown === c ? "border-accent/60 text-primary" : "border-border text-secondary"
                            )}
                            data-testid={`setup-analyse-channel-${c}`}
                        >
                            {c === "rc" && !rcShown ? t("mc.setup.analyse.rcNone") : t(`mc.setup.flow.${c}`)}
                        </button>
                    ))}
                </div>
            )}
            <FlowDiagram model={model} selected={selected} onSelect={setSelected} />
            <div className="grid grid-cols-1 gap-3 @min-[56rem]:grid-cols-[3fr_2fr]">
                <div className={BlockClass}>
                    <span className={ChipClass}>{t("mc.setup.analyse.understood")}</span>
                    <p className="text-12 text-secondary">{t("mc.setup.analyse.understoodIntro")}</p>
                    <ol className="flex flex-col gap-1.5" data-testid="setup-points">
                        {points.map((p) => (
                            <PointRow
                                key={p.key}
                                point={p}
                                number={numbers[p.key]}
                                draft={draft}
                                answers={answers}
                                selected={p.key === selected}
                                onSelect={() => setSelected(p.key === selected ? null : p.key)}
                                onAnswer={(value) => onAnswer(p.key, value)}
                            />
                        ))}
                    </ol>
                </div>
                <div className={BlockClass} data-testid="setup-adjust">
                    <span className={ChipClass}>
                        {point
                            ? t("mc.setup.analyse.adjustTitle", { n: numbers[point.key] })
                            : t("mc.setup.analyse.adjustNone")}
                    </span>
                    {!point ? (
                        <p className="text-12 text-secondary">{t("mc.setup.analyse.adjustHint")}</p>
                    ) : !adjustable ? (
                        <p className="text-12 text-secondary">{t("mc.setup.analyse.adjustFact")}</p>
                    ) : (
                        <>
                            <p className="text-12 text-secondary">
                                {point.kind === "protection" || point.kind === "merge"
                                    ? t("mc.setup.analyse.adjustGithub")
                                    : t("mc.setup.analyse.adjustIntro")}
                            </p>
                            <div className="flex flex-col gap-1.5" role="radiogroup">
                                {point.choices.map((c) => (
                                    <ChoiceOption
                                        key={c.id}
                                        choice={c}
                                        label={choiceLabel(point, draft, c.id)}
                                        selected={answerOf(point, answers) === c.id}
                                        asRead={c.id === point.selected}
                                        onSelect={() => onAnswer(point.key, c.id)}
                                    />
                                ))}
                            </div>
                        </>
                    )}
                    <p className="text-11 text-muted">{t("mc.setup.analyse.agentLater")}</p>
                </div>
            </div>
        </div>
    );
}
