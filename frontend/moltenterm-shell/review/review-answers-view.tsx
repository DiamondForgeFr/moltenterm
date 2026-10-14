// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The AI panel's questions and answers (FR-REV-006): the questions waiting for the agent to be idle, with Remove, and
// the agent's answers as cards grouped by the lines they are about, a follow-up under the first answer. A gutter
// marker's click brings its group into view. The answers' markdown is the agent's: rendered, never executed; links
// into the PR open the file in the diff.

import { Markdown } from "@/app/element/markdown";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnswerGroup, groupAnswers, PrAnswersKey } from "./review-answers";
import { ReviewExplanation } from "./review-client";
import { parseFileLink } from "./review-model";
import { anchorLabel } from "./review-selection";
import { ReviewQueuedQuestion } from "./review-session";
import type { ReviewTabModel } from "./review-tab-model";

import "./review.css";

// UI strings, one per constant (interface translation keys come later, #623).
const AnswersTitle = "Questions and answers";
const AnswersEmpty = "Select lines and Ask the AI: the answers show here, and a spark marks their lines in the diff.";
const WholePrLabel = "The whole PR";
const EarlierHeadLabel = "Earlier head";
const EarlierHeadHint = "Answered on an earlier head of the PR: the lines may have changed since.";
const ShowLinesHint = "Show these lines in the diff";
const QuestionLabel = "You asked";
const DepthLabels: Record<string, string> = { quick: "Quick", detailed: "Detailed" };
const UpdatedLabel = "Updated";
const SourcesLabel = "Sources";
const RelatedLabel = "Also in the code";
const PrinciplesLabel = "Principles";
const QueueTitle = "Waiting for your agent";
const QueueHint = "Each one is sent when the agent is idle, in this order.";
const RemoveQuestionLabel = "Remove this question";
const FocusMs = 2000;

// QuestionQueue lists the questions waiting for the agent (AC4), with what holds the queue.
export function QuestionQueue({ model }: { model: ReviewTabModel }) {
    const ai = useAtomValue(model.aiAtom);
    const [error, setError] = useState<string>(null);
    const questions = ai.session?.questions ?? [];
    const note = ai.session?.queuenote;
    if (questions.length === 0 && !note) {
        return null;
    }
    return (
        <section className="flex flex-col gap-1.5" aria-label={QueueTitle} data-testid="review-question-queue">
            {questions.length > 0 ? (
                <>
                    <div className="flex items-center gap-1.5 font-medium">
                        <i className="fa fa-solid fa-hourglass-half text-11 text-warning" />
                        {QueueTitle} ({questions.length})
                    </div>
                    <div className="text-11 text-muted">{QueueHint}</div>
                    <ol className="flex flex-col gap-1">
                        {questions.map((q, i) => (
                            <QueuedRow
                                key={q.id}
                                question={q}
                                place={i + 1}
                                onRemove={() => fireAndForget(async () => setError(await model.cancelQuestion(q.id)))}
                            />
                        ))}
                    </ol>
                </>
            ) : null}
            {note ? (
                <p className="text-11 text-warning" data-testid="review-question-queue-note">
                    {note}
                </p>
            ) : null}
            {error ? <p className="text-11 text-error">{error}</p> : null}
        </section>
    );
}

function QueuedRow({
    question,
    place,
    onRemove,
}: {
    question: ReviewQueuedQuestion;
    place: number;
    onRemove: () => void;
}) {
    return (
        <li
            className="flex items-start gap-1.5 rounded-4 border border-border px-2 py-1"
            data-testid="review-queued-question"
        >
            <span className="text-11 text-muted">{place}.</span>
            <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-11 text-muted">
                    {question.anchor ? anchorLabel(question.anchor) : WholePrLabel}
                </span>
                <span className="line-clamp-2 whitespace-pre-wrap">{question.question}</span>
            </div>
            <button
                type="button"
                className="cursor-pointer px-1 text-muted hover:text-error"
                onClick={onRemove}
                title={RemoveQuestionLabel}
                aria-label={RemoveQuestionLabel}
                data-testid="review-queued-remove"
            >
                <i className="fa fa-solid fa-xmark text-11" />
            </button>
        </li>
    );
}

// AnswersSection is the agent's answers, grouped by their lines, the latest activity first.
export function AnswersSection({ model }: { model: ReviewTabModel }) {
    const state = useAtomValue(model.stateAtom);
    const head = useAtomValue(model.headAtom);
    const focus = useAtomValue(model.answerFocusAtom);
    const groups = useMemo(() => groupAnswers(state?.explanations, head), [state?.explanations, head]);
    return (
        <section className="flex flex-col gap-2" aria-label={AnswersTitle} data-testid="review-answers">
            <div className="text-13 font-semibold">{AnswersTitle}</div>
            {groups.length === 0 ? <p className="text-muted">{AnswersEmpty}</p> : null}
            {groups.map((g) => (
                <AnswerGroupCard key={g.key} model={model} group={g} focusSeq={focus?.key === g.key ? focus.seq : 0} />
            ))}
        </section>
    );
}

function AnswerGroupCard({ model, group, focusSeq }: { model: ReviewTabModel; group: AnswerGroup; focusSeq: number }) {
    const ref = useRef<HTMLElement>(null);
    const [focused, setFocused] = useState(false);
    useEffect(() => {
        if (!focusSeq) {
            return;
        }
        ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        setFocused(true);
        const timer = setTimeout(() => setFocused(false), FocusMs);
        return () => clearTimeout(timer);
    }, [focusSeq]);
    const onClickCapture = (e: React.MouseEvent) => {
        const link = parseFileLink((e.target as HTMLElement).closest?.("a")?.getAttribute("href"));
        if (link == null) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        model.revealFile(link);
    };
    return (
        <article
            ref={ref}
            className={cn(
                "flex flex-col gap-2 rounded-6 border border-border p-2.5 transition-shadow duration-200",
                focused && "molten-review-answer-focus"
            )}
            data-testid="review-answer-group"
            data-key={group.key}
        >
            <div className="flex items-center gap-1.5">
                <i className="fa fa-solid fa-sparkles text-11 text-accent" />
                {group.key === PrAnswersKey ? (
                    <span className="min-w-0 truncate font-medium">{WholePrLabel}</span>
                ) : (
                    <button
                        type="button"
                        className="min-w-0 cursor-pointer truncate text-left font-mono text-11 text-secondary hover:text-primary"
                        onClick={() => model.revealAnchor(group.anchor)}
                        title={ShowLinesHint}
                        data-testid="review-answer-anchor"
                    >
                        {anchorLabel(group.anchor)}
                    </button>
                )}
                {group.stale ? (
                    <span
                        className="ml-auto shrink-0 rounded-4 border border-warning/50 px-1 text-10 text-warning"
                        title={EarlierHeadHint}
                    >
                        {EarlierHeadLabel}
                    </span>
                ) : null}
            </div>
            {group.anchor?.excerpt ? (
                <pre className="max-h-16 overflow-hidden rounded-4 bg-panel px-2 py-1 font-mono text-11 whitespace-pre-wrap text-muted">
                    {group.anchor.excerpt}
                </pre>
            ) : null}
            {group.answers.map((answer) => (
                <AnswerBody key={answer.id} model={model} answer={answer} onClickCapture={onClickCapture} />
            ))}
        </article>
    );
}

function AnswerBody({
    model,
    answer,
    onClickCapture,
}: {
    model: ReviewTabModel;
    answer: ReviewExplanation;
    onClickCapture: (e: React.MouseEvent) => void;
}) {
    return (
        <div
            className="flex flex-col gap-1.5 border-t border-border/50 pt-2"
            data-testid="review-answer"
            data-id={answer.id}
        >
            {answer.question ? (
                <div className="flex flex-col gap-0.5" data-testid="review-answer-question">
                    <span className="text-10 font-medium text-muted uppercase">{QuestionLabel}</span>
                    <span className="whitespace-pre-wrap text-secondary">{answer.question}</span>
                </div>
            ) : null}
            <div
                className={cn(
                    "min-w-0",
                    "[&_.heading]:!mt-3 [&_.heading]:!border-b-0 [&_.heading]:!pt-0 [&_.heading]:!pb-0 [&_.heading]:!text-13 [&_.heading]:!font-semibold"
                )}
                onClickCapture={onClickCapture}
                data-testid="review-answer-body"
            >
                <Markdown text={answer.markdown} scrollable={false} fontSizeOverride={12} fixedFontSizeOverride={11} />
            </div>
            <AnswerFooter model={model} answer={answer} />
        </div>
    );
}

function AnswerFooter({ model, answer }: { model: ReviewTabModel; answer: ReviewExplanation }) {
    const related = (answer.related ?? []).filter((r) => r.trim() !== "");
    const sources = (answer.sources ?? []).filter((s) => s.trim() !== "");
    const principles = (answer.principles ?? []).filter((p) => p.trim() !== "");
    return (
        <div className="flex flex-col gap-1 text-11 text-muted">
            <div className="flex flex-wrap items-center gap-1.5">
                {answer.depth ? (
                    <span className="rounded-4 border border-border px-1 text-10">
                        {DepthLabels[answer.depth] ?? answer.depth}
                    </span>
                ) : null}
                {answer.updatedat ? <span>{UpdatedLabel}</span> : null}
                {principles.length > 0 ? (
                    <span>
                        {PrinciplesLabel}: {principles.join(", ")}
                    </span>
                ) : null}
            </div>
            {related.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1">
                    <span>{RelatedLabel}:</span>
                    {related.map((r) => {
                        const link = parseFileLink(r);
                        return (
                            <button
                                key={r}
                                type="button"
                                className="cursor-pointer font-mono text-secondary hover:text-primary disabled:cursor-default"
                                disabled={link == null}
                                onClick={() => link != null && model.revealFile(link)}
                            >
                                {r}
                            </button>
                        );
                    })}
                </div>
            ) : null}
            {sources.length > 0 ? (
                <div>
                    {SourcesLabel}: {sources.join(" · ")}
                </div>
            ) : null}
        </div>
    );
}
