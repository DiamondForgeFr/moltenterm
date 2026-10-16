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
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { AnswerGroup, citedLine, groupAnswers, PrAnswersKey } from "./review-answers";
import { ReviewExplanation } from "./review-client";
import { parseFileLink } from "./review-model";
import { keepReviewNote, keptNoteOf, useReviewNotes } from "./review-notes";
import { anchorLabel } from "./review-selection";
import { ReviewQueuedQuestion } from "./review-session";
import type { ReviewTabModel } from "./review-tab-model";

import "./review.css";

const DepthKeys: Record<string, string> = {
    quick: "review.answers.depthQuick",
    detailed: "review.answers.depthDetailed",
};
const FocusMs = 2000;

// QuestionQueue lists the questions waiting for the agent (AC4), with what holds the queue.
export function QuestionQueue({ model }: { model: ReviewTabModel }) {
    const t = useT();
    const ai = useAtomValue(model.aiAtom);
    const [error, setError] = useState<string>(null);
    const questions = ai.session?.questions ?? [];
    const note = ai.session?.queuenote;
    if (questions.length === 0 && !note) {
        return null;
    }
    return (
        <section
            className="flex flex-col gap-1.5"
            aria-label={t("review.answers.queueTitle")}
            data-testid="review-question-queue"
        >
            {questions.length > 0 ? (
                <>
                    <div className="flex items-center gap-1.5 font-medium">
                        <i className="fa fa-solid fa-hourglass-half text-11 text-warning" />
                        {t("review.answers.queueTitleCount", { count: questions.length })}
                    </div>
                    <div className="text-11 text-muted">{t("review.answers.queueHint")}</div>
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
            {error ? <p className="text-11 text-danger">{error}</p> : null}
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
    const t = useT();
    return (
        <li
            className="flex items-start gap-1.5 rounded-4 border border-border px-2 py-1"
            data-testid="review-queued-question"
        >
            <span className="text-11 text-muted">{place}.</span>
            <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate font-mono text-11 text-muted">
                        {question.anchor ? anchorLabel(question.anchor) : t("review.answers.wholePr")}
                    </span>
                    {question.depth === "detailed" ? (
                        <span className="shrink-0 rounded-4 border border-border px-1 text-10 text-muted">
                            {t("review.answers.depthDetailed")}
                        </span>
                    ) : null}
                </span>
                <span className="line-clamp-2 whitespace-pre-wrap">{question.question}</span>
            </div>
            <button
                type="button"
                className="cursor-pointer px-1 text-muted hover:text-error"
                onClick={onRemove}
                title={t("review.answers.removeQuestion")}
                aria-label={t("review.answers.removeQuestion")}
                data-testid="review-queued-remove"
            >
                <i className="fa fa-solid fa-xmark text-11" />
            </button>
        </li>
    );
}

// AnswersSection is the agent's answers, grouped by their lines, the latest activity first.
export function AnswersSection({ model }: { model: ReviewTabModel }) {
    const t = useT();
    const state = useAtomValue(model.stateAtom);
    const head = useAtomValue(model.headAtom);
    const focus = useAtomValue(model.answerFocusAtom);
    const pr = useAtomValue(model.prAtom);
    const notes = useReviewNotes(pr?.repo);
    const groups = useMemo(() => groupAnswers(state?.explanations, head), [state?.explanations, head]);
    return (
        <section className="flex flex-col gap-2" aria-label={t("review.answers.title")} data-testid="review-answers">
            <div className="text-13 font-semibold">{t("review.answers.title")}</div>
            {groups.length === 0 ? <p className="text-muted">{t("review.answers.empty")}</p> : null}
            {groups.map((g) => (
                <AnswerGroupCard
                    key={g.key}
                    model={model}
                    group={g}
                    focusSeq={focus?.key === g.key ? focus.seq : 0}
                    notes={notes}
                />
            ))}
        </section>
    );
}

type NotesHandle = ReturnType<typeof useReviewNotes>;

function AnswerGroupCard({
    model,
    group,
    focusSeq,
    notes,
}: {
    model: ReviewTabModel;
    group: AnswerGroup;
    focusSeq: number;
    notes: NotesHandle;
}) {
    const t = useT();
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
        model.openCodeLink(link);
    };
    return (
        <article
            ref={ref}
            className={cn(
                "flex flex-col gap-2 rounded-6 border border-border p-2.5 transition-shadow duration-120 ease-mt",
                focused && "molten-review-answer-focus"
            )}
            data-testid="review-answer-group"
            data-key={group.key}
        >
            <div className="flex items-center gap-1.5">
                <i className="fa fa-solid fa-sparkles text-11 text-accent" />
                {group.key === PrAnswersKey ? (
                    <span className="min-w-0 truncate font-medium">{t("review.answers.wholePr")}</span>
                ) : (
                    <button
                        type="button"
                        className="min-w-0 cursor-pointer truncate text-left font-mono text-11 text-secondary hover:text-primary"
                        onClick={() => model.revealAnchor(group.anchor)}
                        title={t("review.answers.showLines")}
                        data-testid="review-answer-anchor"
                    >
                        {anchorLabel(group.anchor)}
                    </button>
                )}
                {group.stale ? (
                    <span
                        className="ml-auto shrink-0 rounded-4 border border-warning/50 px-1 text-10 text-warning"
                        title={t("review.answers.earlierHeadHint")}
                    >
                        {t("review.answers.earlierHead")}
                    </span>
                ) : null}
            </div>
            {group.anchor?.excerpt ? (
                <pre className="max-h-16 overflow-hidden rounded-4 bg-panel px-2 py-1 font-mono text-11 whitespace-pre-wrap text-muted">
                    {group.anchor.excerpt}
                </pre>
            ) : null}
            {group.answers.map((answer) => (
                <AnswerBody
                    key={answer.id}
                    model={model}
                    answer={answer}
                    onClickCapture={onClickCapture}
                    notes={notes}
                />
            ))}
        </article>
    );
}

function AnswerBody({
    model,
    answer,
    onClickCapture,
    notes,
}: {
    model: ReviewTabModel;
    answer: ReviewExplanation;
    onClickCapture: (e: React.MouseEvent) => void;
    notes: NotesHandle;
}) {
    const t = useT();
    return (
        <div
            className="flex flex-col gap-1.5 border-t border-border/50 pt-2"
            data-testid="review-answer"
            data-id={answer.id}
        >
            {answer.question ? (
                <div className="flex flex-col gap-0.5" data-testid="review-answer-question">
                    <span className="text-10 font-medium text-muted uppercase">{t("review.answers.youAsked")}</span>
                    <span className="whitespace-pre-wrap text-secondary">{answer.question}</span>
                </div>
            ) : null}
            <AnswerHeading answer={answer} />
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
            <KeepButton model={model} answer={answer} notes={notes} />
        </div>
    );
}

// KeepButton keeps the answer as a note of the project (FR-REV-008 AC1), listed in the Reviews view's Notes.
function KeepButton({ model, answer, notes }: { model: ReviewTabModel; answer: ReviewExplanation; notes: NotesHandle }) {
    const t = useT();
    const pr = useAtomValue(model.prAtom);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>(null);
    const kept = keptNoteOf(notes.notes?.notes, pr?.number, answer.id);
    if (pr == null) {
        return null;
    }
    const keep = () =>
        fireAndForget(async () => {
            setBusy(true);
            setError(null);
            try {
                notes.set(
                    await keepReviewNote({
                        repo: pr.repo,
                        number: pr.number,
                        explanationid: answer.id,
                        prtitle: pr.title,
                        prurl: pr.url,
                        baseref: pr.baseref,
                    })
                );
            } catch (e) {
                setError(serverErrorText(e));
            } finally {
                setBusy(false);
            }
        });
    return (
        <div className="flex items-center gap-2 text-11">
            {kept ? (
                <span
                    className="flex items-center gap-1 text-success"
                    title={t("review.notes.keptHint", { title: kept.title })}
                    data-testid="review-answer-kept"
                >
                    <i className="fa fa-solid fa-bookmark text-10" />
                    {t("review.notes.kept")}
                </span>
            ) : (
                <button
                    type="button"
                    className="flex cursor-pointer items-center gap-1 rounded-4 border border-border px-1.5 py-0.5 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50"
                    onClick={keep}
                    disabled={busy || notes.notes == null}
                    title={t("review.notes.keepHint")}
                    data-testid="review-answer-keep"
                >
                    <i className="fa fa-regular fa-bookmark text-10" />
                    {t("review.notes.keep")}
                </button>
            )}
            {error ? <span className="text-danger">{error}</span> : null}
        </div>
    );
}

// AnswerHeading: the technique the answer teaches (AC1), its depth, and the principles it names (AC5), above the text.
function AnswerHeading({ answer }: { answer: ReviewExplanation }) {
    const t = useT();
    const principles = (answer.principles ?? []).filter((p) => p.trim() !== "");
    const technique = answer.technique?.trim();
    return (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="review-answer-heading">
            {technique ? (
                <span
                    className="min-w-0 font-semibold text-primary"
                    title={t("review.answers.techniqueHint")}
                    data-testid="review-answer-technique"
                >
                    {technique}
                </span>
            ) : null}
            {answer.depth ? (
                <span
                    className="rounded-4 border border-border px-1 text-10 text-muted"
                    data-testid="review-answer-depth"
                >
                    {DepthKeys[answer.depth] ? t(DepthKeys[answer.depth]) : answer.depth}
                </span>
            ) : null}
            {answer.updatedat ? <span className="text-10 text-muted">{t("review.answers.updated")}</span> : null}
            {principles.map((p) => (
                <span
                    key={p}
                    className="rounded-4 bg-accent/10 px-1 text-10 text-accent"
                    title={t("review.answers.principleHint")}
                    data-testid="review-answer-principle"
                >
                    {p}
                </span>
            ))}
        </div>
    );
}

// CodeRef is a path:line an answer cites: it opens the file at the line, in the diff or from the worktree (AC4).
function CodeRef({ model, text }: { model: ReviewTabModel; text: string }) {
    const t = useT();
    const link = citedLine(text);
    if (link == null) {
        return <span className="break-words">{text}</span>;
    }
    return (
        <button
            type="button"
            className="cursor-pointer text-left font-mono break-all text-secondary hover:text-primary hover:underline"
            onClick={() => model.openCodeLink(link)}
            title={t("review.answers.openLine")}
            data-testid="review-answer-coderef"
        >
            {text}
        </button>
    );
}

// AnswerFooter: where else the code uses the technique, then the sources, last (AC4, AC8).
function AnswerFooter({ model, answer }: { model: ReviewTabModel; answer: ReviewExplanation }) {
    const t = useT();
    const related = (answer.related ?? []).filter((r) => r.trim() !== "");
    const sources = (answer.sources ?? []).filter((s) => s.trim() !== "");
    return (
        <div className="flex flex-col gap-1 text-11 text-muted">
            {related.length > 0 ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5" data-testid="review-answer-related">
                    <span>{t("review.answers.related")}</span>
                    {related.map((r) => (
                        <CodeRef key={r} model={model} text={r} />
                    ))}
                </div>
            ) : null}
            {sources.length > 0 ? (
                <div className="flex flex-col gap-0.5" data-testid="review-answer-sources">
                    <span className="text-10 font-medium uppercase">{t("review.answers.sourcesTitle")}</span>
                    <ul className="flex list-disc flex-col gap-0.5 pl-4">
                        {sources.map((s) => (
                            <li key={s}>
                                <CodeRef model={model} text={s} />
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </div>
    );
}
