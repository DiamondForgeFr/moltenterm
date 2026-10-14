// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ReviewComment, ReviewState } from "./review-client";
import {
    canPost,
    landing,
    langCode,
    linesLabel,
    missingTranslations,
    publishableComments,
    PublishText,
    retryable,
    sameLang,
} from "./review-publish";

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
    return {
        id: "c1",
        anchor: { path: "a.go", side: "RIGHT", startline: 3, line: 5, headoid: "a".repeat(40), excerpt: "x" },
        subject: "line",
        kind: "comment",
        state: "staged",
        original: { lang: "fr", text: "Pourquoi ?" },
        author: "developer",
        createdat: 1,
        ...over,
    };
}

function state(comments: ReviewComment[], over: Partial<ReviewState> = {}): ReviewState {
    return { repo: "o/n", number: 7, viewed: {}, rounds: [], comments, ...over };
}

describe("publish review", () => {
    it("compares languages by their code", () => {
        expect(langCode("fr-FR")).toBe("fr");
        expect(langCode("EN_us")).toBe("en");
        expect(sameLang("fr-FR", "fr")).toBe(true);
        expect(sameLang("fr", "en")).toBe(false);
        expect(sameLang("", "en")).toBe(true);
    });

    it("waits for every translation before Post review, not before Post as written", () => {
        const fr = comment();
        const en = comment({ id: "c2", original: { lang: "en-US", text: "Why?" } });
        const draft = comment({ id: "c3", state: "draft" });
        const st = state([fr, en, draft], { summary: { original: { lang: "fr", text: "Merci" } } });
        expect(publishableComments(st).map((c) => c.id)).toEqual(["c1", "c2"]);
        expect(missingTranslations(st, "en")).toBe(2);
        expect(canPost(st, "en", false, false)).toBe(false);
        expect(canPost(st, "en", true, false)).toBe(true);
        expect(canPost(st, "en", true, true)).toBe(false);
        fr.translation = { lang: "en", text: "Why?" };
        st.summary.translation = { lang: "en", text: "  " };
        expect(missingTranslations(st, "en")).toBe(1);
        st.summary.translation = { lang: "en", text: "Thanks", editedbyuser: true };
        expect(canPost(st, "en", false, false)).toBe(true);
        // A translation into another language does not count.
        fr.translation = { lang: "de", text: "Warum?" };
        expect(missingTranslations(st, "en")).toBe(1);
        expect(missingTranslations(st, "fr")).toBe(1);
    });

    it("needs something to publish", () => {
        expect(canPost(state([]), "en", true, false)).toBe(false);
        expect(canPost(state([], { summary: { original: { lang: "en", text: "LGTM" } } }), "en", false, false)).toBe(
            true
        );
    });

    it("says where each comment lands", () => {
        expect(landing(comment()).kind).toBe("line");
        expect(landing(comment({ subject: "file" }))).toEqual({ kind: "file", label: PublishText.fileLevel });
        expect(landing(comment({ outdated: true }))).toEqual({ kind: "file", label: PublishText.outdated });
        expect(linesLabel(comment())).toBe("R3-R5");
        expect(linesLabel(comment({ anchor: { path: "a", side: "LEFT", line: 9 } }))).toBe("L9");
    });

    it("offers to post the rest after a partial or failed publication", () => {
        const rec = { roundid: "r", lang: "en", headoid: "a", startedat: 1 };
        expect(retryable({ ...rec, state: "partial" })).toBe(true);
        expect(retryable({ ...rec, state: "failed" })).toBe(true);
        expect(retryable({ ...rec, state: "published" })).toBe(false);
        expect(retryable(null)).toBe(false);
    });
});
