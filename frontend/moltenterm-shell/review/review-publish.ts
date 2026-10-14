// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Publish review (FR-REV-010, DS-REV-008): what the Publish sheet shows of each staged comment (its original, its
// translation into the publication language, where it lands on GitHub) and when Post review can be clicked. wavesrv
// decides the rest at the click (pkg/molten/review/publish.go).

import type {
    ReviewComment,
    ReviewCommentText,
    ReviewLanguage,
    ReviewPublishNoteKind,
    ReviewPublishRecord,
    ReviewState,
} from "./review-client";
import { isStaged } from "./review-selection";

// The sheet's words, in one place until the interface's strings move to keys (#623).
export const PublishText = {
    title: (num: number) => `Publish review #${num}`,
    subtitle: (lang: string, head: string) => `One GitHub review in ${lang}, on head ${head}`,
    language: "Publication language",
    languageSource: {
        project: "from the project's .saasfoundry.json",
        setting: "from the review:publishlanguage setting",
        detected: "detected from the project's pull requests and README",
        default: "the default: the project declares none and its history says too little",
    } as Record<ReviewLanguage["source"], string>,
    readingLanguage: "Reading the publication language…",
    original: "Your text",
    translation: (lang: string) => `Published in ${lang}`,
    asIs: (lang: string) => `Already in ${lang}: published as written`,
    translationPlaceholder: "Your agent's translation shows here; you can also write it.",
    summary: "Review summary (optional)",
    summaryPlaceholder: "A few words for the author, shown above the comments",
    summaryTranslationPlaceholder: "The summary's translation",
    editedByYou: "edited by you",
    lineComment: "Line comment",
    fileComment: "File comment",
    outdated: "Outdated: posted as a file comment quoting its lines",
    fileLevel: "File-level: posted as a file comment quoting its lines",
    translateAgain: "Translate again",
    translateAgainTitle: "Ask your agent again for every translation you did not edit",
    translate: "Translate",
    translating: (n: number) => `Your agent is translating ${n} ${n === 1 ? "text" : "texts"}…`,
    translateBusy: "Your agent is busy: nothing was asked. Translate again when it is idle.",
    translateTyped: "The request waits in your agent's prompt behind your draft: send it there.",
    noSession: "No review session: write the translations, or post as written.",
    nothingToTranslate: "Every text is in the publication language.",
    missing: (n: number, lang: string) => `${n} ${n === 1 ? "text is" : "texts are"} not in ${lang} yet.`,
    cancel: "Cancel",
    close: "Close",
    postAsWritten: "Post as written",
    postAsWrittenTitle: "Publish your texts without translation",
    post: "Post review",
    postTitle: "Post one GitHub review with these comments; nothing is posted before this click",
    postAgain: "Post the rest",
    postAgainTitle: "Post only what GitHub does not have yet; the review is not posted twice",
    posting: "Posting the review on GitHub…",
    published: "Review posted on GitHub",
    partial: "Review posted on GitHub, but some comments are not",
    failed: "The review could not be posted",
    openOnGithub: "Open the review on GitHub",
    nothing: "No comment is staged.",
    note: {
        filelevel: "posted as a file comment",
        outdated: "outdated: posted as a file comment quoting its lines",
        otherhead: "made on another head: posted as a file comment",
        outsidediff: "outside the diff: posted as a file comment",
        refused: "GitHub refused its lines: re-posted as a file comment",
        late: "staged after the review was posted: posted as a file comment",
        notinpr: "its file left the pull request: quoted in the review's text",
        failed: "not posted",
    } as Record<ReviewPublishNoteKind, string>,
};

// langCode turns fr-FR, fr_FR or FR into fr; "" stays "".
export function langCode(lang: string): string {
    return (lang ?? "").trim().split(/[-_.]/)[0].toLowerCase();
}

// sameLang: an unknown language ("") is taken as the other, as wavesrv does.
export function sameLang(a: string, b: string): boolean {
    const ca = langCode(a);
    const cb = langCode(b);
    return ca === "" || cb === "" || ca === cb;
}

// needsTranslation: a text in another language than the publication's.
export function needsTranslation(original: ReviewCommentText, lang: string): boolean {
    return original != null && !sameLang(original.lang, lang);
}

export function hasTranslation(translation: ReviewCommentText, lang: string): boolean {
    return translation != null && (translation.text ?? "").trim() !== "" && sameLang(translation.lang, lang);
}

export function publishableComments(state: ReviewState): ReviewComment[] {
    return (state?.comments ?? []).filter(isStaged);
}

// missingTranslations counts the texts (comments and summary) Post review still waits for.
export function missingTranslations(state: ReviewState, lang: string): number {
    if (!lang) {
        return 0;
    }
    let n = 0;
    for (const c of publishableComments(state)) {
        if (needsTranslation(c.original, lang) && !hasTranslation(c.translation, lang)) {
            n++;
        }
    }
    const summary = state?.summary;
    if (summary != null && needsTranslation(summary.original, lang) && !hasTranslation(summary.translation, lang)) {
        n++;
    }
    return n;
}

export function hasSomethingToPublish(state: ReviewState): boolean {
    return publishableComments(state).length > 0 || (state?.summary?.original?.text ?? "").trim() !== "";
}

// canPost: Post review needs every translation; Post as written only something to publish.
export function canPost(state: ReviewState, lang: string, asWritten: boolean, busy: boolean): boolean {
    if (busy || !lang || !hasSomethingToPublish(state)) {
        return false;
    }
    return asWritten || missingTranslations(state, lang) === 0;
}

// landing says how a comment goes to GitHub as far as the sheet knows (wavesrv also checks the head and the hunks).
export function landing(comment: ReviewComment): { kind: "line" | "file"; label: string } {
    if (comment.outdated) {
        return { kind: "file", label: PublishText.outdated };
    }
    if (comment.subject !== "line") {
        return { kind: "file", label: PublishText.fileLevel };
    }
    return { kind: "line", label: PublishText.lineComment };
}

// linesLabel names a comment's lines as GitHub's anchors do: R for the head side, L for the base.
export function linesLabel(comment: ReviewComment): string {
    const a = comment.anchor;
    const prefix = a.side === "LEFT" ? "L" : "R";
    if (a.startline > 0 && a.startline !== a.line) {
        return `${prefix}${a.startline}-${prefix}${a.line}`;
    }
    return `${prefix}${a.line}`;
}

export function publishRunning(record: ReviewPublishRecord): boolean {
    return record?.state === "publishing";
}

export function publishStateLabel(record: ReviewPublishRecord): string {
    switch (record?.state) {
        case "publishing":
            return PublishText.posting;
        case "published":
            return PublishText.published;
        case "partial":
            return PublishText.partial;
        case "failed":
            return PublishText.failed;
    }
    return "";
}

// retryable: an unfinished publication; Post review takes the same round again, so nothing is posted twice.
export function retryable(record: ReviewPublishRecord): boolean {
    return record?.state === "partial" || record?.state === "failed";
}
