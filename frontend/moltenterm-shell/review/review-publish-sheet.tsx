// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Publish sheet (FR-REV-010 AC2 to AC5): each staged comment with its original and its translation side by side,
// both editable, where it lands, and an optional summary. Post review is the only way anything reaches GitHub
// (NFR-REV-003); the outcome, with the link to the review, comes back from the review store.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { DialogFrame, useEscape } from "../dialog-frame";
import { useLocale } from "../i18n/i18n";
import { serverText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { openWebLink } from "../open-web-link";
import { DominoLoader } from "../suite/suite";
import { ReviewComment, ReviewCommentText, ReviewPublishRecord, ReviewState, ReviewSummaryId } from "./review-client";
import { shortOid } from "./review-model";
import {
    canPost,
    hasSomethingToPublish,
    landing,
    linesLabel,
    missingTranslations,
    needsTranslation,
    publishableComments,
    publishRunning,
    publishStateLabel,
    PublishText,
    retryable,
} from "./review-publish";
import { ReviewPublishSheet, ReviewTabModel } from "./review-tab-model";

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";
const TextBox =
    "min-h-[56px] w-full resize-y rounded-6 border border-border bg-surface-1 px-2 py-1.5 text-12 leading-5 text-primary outline-none focus:border-accent disabled:opacity-60";

export function PublishSheet({ model }: { model: ReviewTabModel }) {
    useLocale();
    const sheet = useAtomValue(model.publishAtom);
    const pr = useAtomValue(model.prAtom);
    const state = useAtomValue(model.stateAtom);
    const head = useAtomValue(model.headAtom);
    useEscape(sheet.open && !sheet.posting, () => model.closePublish());
    if (!sheet.open || pr == null) {
        return null;
    }
    const lang = sheet.language;
    // An unfinished publication shows again with what is missing; a finished one only after this sheet's click.
    const record = sheet.clicked || retryable(state?.publish) ? state?.publish : null;
    const done = record?.state === "published";
    const locked = sheet.posting || publishRunning(state?.publish) || done;
    return (
        <DialogFrame
            role="review-publish"
            title={PublishText.title(pr.number)}
            subtitle={lang ? PublishText.subtitle(lang.name, shortOid(head)) : PublishText.readingLanguage}
            widthClass="w-[820px]"
            trapFocus
            buttons={<SheetButtons model={model} sheet={sheet} state={state} record={record} />}
        >
            {sheet.error ? <ErrorLine text={sheet.error} testid="publish-error" /> : null}
            {sheet.languageError ? <ErrorLine text={sheet.languageError} testid="publish-language-error" /> : null}
            {record != null || sheet.posting ? (
                <PublishOutcome record={record} posting={sheet.posting} state={state} />
            ) : null}
            {lang != null ? (
                <div className="text-muted" data-testid="publish-language" data-lang={lang.lang}>
                    {PublishText.language}: <span className="text-primary">{lang.name}</span>,{" "}
                    {PublishText.languageSource[lang.source]}.
                </div>
            ) : null}
            {lang != null && !done ? <TranslateLine model={model} sheet={sheet} state={state} /> : null}
            {lang != null && !done ? (
                <>
                    <SummaryEditor model={model} state={state} lang={lang.lang} langName={lang.name} locked={locked} />
                    {publishableComments(state).length === 0 ? (
                        <div className="text-muted">{PublishText.nothing}</div>
                    ) : (
                        publishableComments(state).map((c) => (
                            <CommentRow
                                key={c.id}
                                model={model}
                                comment={c}
                                lang={lang.lang}
                                langName={lang.name}
                                locked={locked}
                            />
                        ))
                    )}
                </>
            ) : null}
        </DialogFrame>
    );
}

function ErrorLine({ text, testid }: { text: string; testid: string }) {
    return (
        <div className="rounded-4 border border-error/40 bg-error/10 px-2 py-1.5 text-danger" data-testid={testid}>
            {text}
        </div>
    );
}

function translateMessage(sheet: ReviewPublishSheet): string {
    const t = sheet.translate;
    switch (t.status) {
        case "asking":
        case "sent":
            return PublishText.translating(t.count ?? 0);
        case "typed":
            return PublishText.translateTyped;
        case "busy":
            return PublishText.translateBusy;
        case "nosession":
            return t.message ? `${PublishText.noSession} ${t.message}` : PublishText.noSession;
        case "none":
            return PublishText.nothingToTranslate;
        case "failed":
            return t.message ?? "";
    }
    return "";
}

function TranslateLine({
    model,
    sheet,
    state,
}: {
    model: ReviewTabModel;
    sheet: ReviewPublishSheet;
    state: ReviewState;
}) {
    const missing = missingTranslations(state, sheet.language.lang);
    const message = translateMessage(sheet);
    const waiting = sheet.translate.status === "asking" || (sheet.translate.status === "sent" && missing > 0);
    return (
        <div
            className="flex items-center gap-2 rounded-6 border border-border px-2 py-1.5"
            data-testid="publish-translate"
            data-status={sheet.translate.status}
            data-missing={missing}
        >
            {waiting ? <DominoLoader className="text-muted" /> : null}
            <span className={cn("min-w-0 flex-1", sheet.translate.status === "failed" ? "text-danger" : "text-muted")}>
                {missing > 0 ? `${PublishText.missing(missing, sheet.language.name)} ` : ""}
                {sheet.translate.status === "sent" && missing === 0 ? "" : message}
            </span>
            <button
                type="button"
                className={PlainButton}
                disabled={sheet.translate.status === "asking"}
                title={PublishText.translateAgainTitle}
                onClick={() => fireAndForget(() => model.requestTranslation(missing === 0))}
                data-testid="publish-translate-again"
            >
                <i className="fa fa-solid fa-language mr-1 text-11" />
                {missing > 0 ? PublishText.translate : PublishText.translateAgain}
            </button>
        </div>
    );
}

// EditableText keeps its own text while the developer types and saves it when they leave the box.
function EditableText({
    value,
    placeholder,
    disabled,
    onSave,
    testid,
}: {
    value: string;
    placeholder?: string;
    disabled?: boolean;
    onSave: (text: string) => Promise<string>;
    testid: string;
}) {
    const [text, setText] = useState(value ?? "");
    const [error, setError] = useState<string>(null);
    const editing = useRef(false);
    useEffect(() => {
        if (!editing.current) {
            setText(value ?? "");
        }
    }, [value]);
    const save = async () => {
        editing.current = false;
        if (text.trim() === (value ?? "").trim()) {
            return;
        }
        setError(await onSave(text));
    };
    return (
        <div className="flex flex-col gap-1">
            <textarea
                className={TextBox}
                value={text}
                placeholder={placeholder}
                disabled={disabled}
                onFocus={() => {
                    editing.current = true;
                }}
                onChange={(e) => setText(e.target.value)}
                onBlur={() => fireAndForget(save)}
                data-testid={testid}
            />
            {error ? <div className="text-danger">{error}</div> : null}
        </div>
    );
}

function Pair({
    original,
    translation,
    lang,
    langName,
    locked,
    onOriginal,
    onTranslation,
    testid,
    placeholders,
}: {
    original: ReviewCommentText;
    translation: ReviewCommentText;
    lang: string;
    langName: string;
    locked: boolean;
    onOriginal: (text: string) => Promise<string>;
    onTranslation: (text: string) => Promise<string>;
    testid: string;
    placeholders?: { original?: string; translation?: string };
}) {
    const translate = original != null && (original.text ?? "") !== "" && needsTranslation(original, lang);
    return (
        <div className={cn("grid gap-2", translate ? "grid-cols-2" : "grid-cols-1")}>
            <div className="flex min-w-0 flex-col gap-1">
                <div className="text-11 text-muted">
                    {translate || !original?.text ? PublishText.original : PublishText.asIs(langName)}
                </div>
                <EditableText
                    value={original?.text ?? ""}
                    placeholder={placeholders?.original}
                    disabled={locked}
                    onSave={onOriginal}
                    testid={`${testid}-original`}
                />
            </div>
            {translate ? (
                <div className="flex min-w-0 flex-col gap-1">
                    <div className="text-11 text-muted">
                        {PublishText.translation(langName)}
                        {translation?.editedbyuser ? ` (${PublishText.editedByYou})` : ""}
                    </div>
                    <EditableText
                        value={translation?.text ?? ""}
                        placeholder={placeholders?.translation ?? PublishText.translationPlaceholder}
                        disabled={locked}
                        onSave={onTranslation}
                        testid={`${testid}-translation`}
                    />
                </div>
            ) : null}
        </div>
    );
}

function SummaryEditor({
    model,
    state,
    lang,
    langName,
    locked,
}: {
    model: ReviewTabModel;
    state: ReviewState;
    lang: string;
    langName: string;
    locked: boolean;
}) {
    const summary = state?.summary;
    return (
        <section className="flex flex-col gap-1" data-testid="publish-summary">
            <div className="font-medium text-muted">{PublishText.summary}</div>
            <Pair
                original={summary?.original ?? { text: "" }}
                translation={summary?.translation}
                lang={lang}
                langName={langName}
                locked={locked}
                onOriginal={(text) => model.saveSummary(text)}
                onTranslation={(text) => model.saveTranslation(ReviewSummaryId, text)}
                testid="publish-summary"
                placeholders={{
                    original: PublishText.summaryPlaceholder,
                    translation: PublishText.summaryTranslationPlaceholder,
                }}
            />
        </section>
    );
}

function CommentRow({
    model,
    comment,
    lang,
    langName,
    locked,
}: {
    model: ReviewTabModel;
    comment: ReviewComment;
    lang: string;
    langName: string;
    locked: boolean;
}) {
    const land = landing(comment);
    return (
        <section
            className="flex flex-col gap-1.5 rounded-6 border border-border px-3 py-2"
            data-testid="publish-comment"
            data-id={comment.id}
            data-state={comment.state}
            data-landing={land.kind}
        >
            <div className="flex items-center gap-2 text-11">
                <i
                    className={cn(
                        "fa fa-solid text-11",
                        comment.kind === "change" ? "fa-pen-to-square text-warning" : "fa-comment text-muted"
                    )}
                />
                <span className="truncate font-mono text-primary" title={comment.anchor.path}>
                    {comment.anchor.path}
                </span>
                <span className="font-mono text-muted">{linesLabel(comment)}</span>
                <span className={cn("ml-auto shrink-0", land.kind === "file" ? "text-warning" : "text-muted")}>
                    {land.kind === "line" ? PublishText.lineComment : land.label}
                </span>
            </div>
            <Pair
                original={comment.original}
                translation={comment.translation}
                lang={lang}
                langName={langName}
                locked={locked}
                onOriginal={(text) => model.updateComment(comment, text, comment.kind)}
                onTranslation={(text) => model.saveTranslation(comment.id, text)}
                testid={`publish-comment-${comment.id}`}
            />
        </section>
    );
}

function PublishOutcome({
    record,
    posting,
    state,
}: {
    record: ReviewPublishRecord;
    posting: boolean;
    state: ReviewState;
}) {
    const running = posting || publishRunning(record);
    const notes = record?.notes ?? [];
    const tone =
        record?.state === "failed" ? "text-danger" : record?.state === "partial" ? "text-warning" : "text-primary";
    return (
        <div
            className="flex flex-col gap-1.5 rounded-6 border border-border px-3 py-2"
            data-testid="publish-outcome"
            data-state={running ? "publishing" : record?.state}
        >
            <div className={cn("flex items-center gap-2 text-13 leading-5", running ? "text-muted" : tone)}>
                {running ? <DominoLoader /> : null}
                <span>{running ? PublishText.posting : publishStateLabel(record)}</span>
                {record?.url && !running ? (
                    <button
                        type="button"
                        className="ml-auto cursor-pointer text-12 text-accent hover:underline"
                        onClick={() => fireAndForget(() => openWebLink(record.url))}
                        data-testid="publish-open-review"
                    >
                        {PublishText.openOnGithub}
                        <i className="fa fa-solid fa-arrow-up-right-from-square ml-1 text-10" />
                    </button>
                ) : null}
            </div>
            {record?.message && !running ? (
                <div className="text-muted">{serverText(record.messagetext, record.message)}</div>
            ) : null}
            {notes.length > 0 && !running ? (
                <ul className="flex flex-col gap-1" data-testid="publish-notes">
                    {notes.map((n) => {
                        const c = state?.comments?.find((x) => x.id === n.commentid);
                        return (
                            <li key={n.commentid} data-note={n.note} className="text-muted">
                                <span className="font-mono text-primary">
                                    {c ? `${c.anchor.path} ${linesLabel(c)}` : n.commentid}
                                </span>
                                : {PublishText.note[n.note] ?? n.note}
                                {n.message ? (
                                    <span className="text-danger"> ({serverText(n.messagetext, n.message)})</span>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            ) : null}
        </div>
    );
}

function SheetButtons({
    model,
    sheet,
    state,
    record,
}: {
    model: ReviewTabModel;
    sheet: ReviewPublishSheet;
    state: ReviewState;
    record: ReviewPublishRecord;
}) {
    if (record?.state === "published") {
        return (
            <button type="button" className={PlainButton} onClick={() => model.closePublish()}>
                {PublishText.close}
            </button>
        );
    }
    const lang = sheet.language?.lang;
    const busy = sheet.posting || publishRunning(state?.publish);
    const missing = lang ? missingTranslations(state, lang) : 0;
    const again = retryable(state?.publish);
    return (
        <>
            <button type="button" className={PlainButton} disabled={sheet.posting} onClick={() => model.closePublish()}>
                {PublishText.cancel}
            </button>
            {missing > 0 ? (
                <button
                    type="button"
                    className={PlainButton}
                    disabled={!canPost(state, lang, true, busy)}
                    title={PublishText.postAsWrittenTitle}
                    onClick={() => fireAndForget(() => model.postReview(true))}
                    data-testid="publish-as-written"
                >
                    {PublishText.postAsWritten}
                </button>
            ) : null}
            <button
                type="button"
                className="molten-btn flex cursor-pointer items-center gap-1.5 rounded-6 px-3 py-1 text-12 disabled:cursor-default disabled:opacity-50"
                disabled={!canPost(state, lang, false, busy) || !hasSomethingToPublish(state)}
                title={
                    missing > 0
                        ? PublishText.missing(missing, sheet.language?.name ?? "")
                        : again
                          ? PublishText.postAgainTitle
                          : PublishText.postTitle
                }
                onClick={() => fireAndForget(() => model.postReview(false))}
                data-testid="publish-post"
            >
                <i className="fa fa-solid fa-paper-plane text-11" />
                {again ? PublishText.postAgain : PublishText.post}
                <MoltenWave />
            </button>
        </>
    );
}
