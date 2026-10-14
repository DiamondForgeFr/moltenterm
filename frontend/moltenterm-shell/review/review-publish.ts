// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Publish review (FR-REV-010, DS-REV-008): what the Publish sheet shows of each staged comment (its original, its
// translation into the publication language, where it lands on GitHub) and when Post review can be clicked. wavesrv
// decides the rest at the click (pkg/molten/review/publish.go).

import { t } from "../i18n/i18n";
import type {
    ReviewComment,
    ReviewCommentText,
    ReviewLanguage,
    ReviewPublishNoteKind,
    ReviewPublishRecord,
    ReviewState,
} from "./review-client";
import { isStaged } from "./review-selection";

// The sheet's words, read in the interface language each time they are shown (#623).
function keyed<K extends string>(prefix: string, keys: readonly K[]): Record<K, string> {
    const rtn = {} as Record<K, string>;
    for (const k of keys) {
        Object.defineProperty(rtn, k, { get: () => t(`${prefix}.${k}`), enumerable: true });
    }
    return rtn;
}

export const PublishText = {
    title: (num: number) => t("review.publish.sheet.title", { num }),
    subtitle: (lang: string, head: string) => t("review.publish.sheet.subtitle", { lang, head }),
    languageSource: keyed("review.publish.sheet.languageSource", [
        "project",
        "setting",
        "detected",
        "default",
    ] as const) as Record<ReviewLanguage["source"], string>,
    translation: (lang: string) => t("review.publish.sheet.translation", { lang }),
    asIs: (lang: string) => t("review.publish.sheet.asIs", { lang }),
    translating: (n: number) =>
        t(n === 1 ? "review.publish.sheet.translatingOne" : "review.publish.sheet.translatingOther", { n }),
    missing: (n: number, lang: string) =>
        t(n === 1 ? "review.publish.sheet.missingOne" : "review.publish.sheet.missingOther", { n, lang }),
    note: keyed("review.publish.sheet.note", [
        "filelevel",
        "outdated",
        "otherhead",
        "outsidediff",
        "refused",
        "late",
        "notinpr",
        "failed",
    ] as const) as Record<ReviewPublishNoteKind, string>,
    get language() {
        return t("review.publish.sheet.language");
    },
    get readingLanguage() {
        return t("review.publish.sheet.readingLanguage");
    },
    get original() {
        return t("review.publish.sheet.original");
    },
    get translationPlaceholder() {
        return t("review.publish.sheet.translationPlaceholder");
    },
    get summary() {
        return t("review.publish.sheet.summary");
    },
    get summaryPlaceholder() {
        return t("review.publish.sheet.summaryPlaceholder");
    },
    get summaryTranslationPlaceholder() {
        return t("review.publish.sheet.summaryTranslationPlaceholder");
    },
    get editedByYou() {
        return t("review.publish.sheet.editedByYou");
    },
    get lineComment() {
        return t("review.publish.sheet.lineComment");
    },
    get fileComment() {
        return t("review.publish.sheet.fileComment");
    },
    get outdated() {
        return t("review.publish.sheet.outdated");
    },
    get fileLevel() {
        return t("review.publish.sheet.fileLevel");
    },
    get translateAgain() {
        return t("review.publish.sheet.translateAgain");
    },
    get translateAgainTitle() {
        return t("review.publish.sheet.translateAgainTitle");
    },
    get translate() {
        return t("review.publish.sheet.translate");
    },
    get translateBusy() {
        return t("review.publish.sheet.translateBusy");
    },
    get translateTyped() {
        return t("review.publish.sheet.translateTyped");
    },
    get noSession() {
        return t("review.publish.sheet.noSession");
    },
    get nothingToTranslate() {
        return t("review.publish.sheet.nothingToTranslate");
    },
    get cancel() {
        return t("review.publish.sheet.cancel");
    },
    get close() {
        return t("review.publish.sheet.close");
    },
    get postAsWritten() {
        return t("review.publish.sheet.postAsWritten");
    },
    get postAsWrittenTitle() {
        return t("review.publish.sheet.postAsWrittenTitle");
    },
    get post() {
        return t("review.publish.sheet.post");
    },
    get postTitle() {
        return t("review.publish.sheet.postTitle");
    },
    get postAgain() {
        return t("review.publish.sheet.postAgain");
    },
    get postAgainTitle() {
        return t("review.publish.sheet.postAgainTitle");
    },
    get posting() {
        return t("review.publish.sheet.posting");
    },
    get published() {
        return t("review.publish.sheet.published");
    },
    get partial() {
        return t("review.publish.sheet.partial");
    },
    get failed() {
        return t("review.publish.sheet.failed");
    },
    get openOnGithub() {
        return t("review.publish.sheet.openOnGithub");
    },
    get nothing() {
        return t("review.publish.sheet.nothing");
    },
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
