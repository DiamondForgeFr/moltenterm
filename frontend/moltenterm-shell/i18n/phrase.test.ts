// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import { markReadyError, rebaseOutcome } from "../reviews/reviews-model";
import { I18nModel } from "./i18n";
import { errorPhrase, joinPhrases, phrase, serverPhrase, wordPhrase } from "./phrase";

function setLanguage(code: string) {
    I18nModel.getInstance().setLanguageSetting(code);
}

const WiredBusy =
    'uimsg:{"code":"review.worktreecreate","vars":{"branch":"b","detail":"busy"}}\ncould not create: busy';

describe("phrases follow the interface language (#1058)", () => {
    afterEach(() => setLanguage("en"));

    it("words a stored key in the language shown, not the one of the click", () => {
        setLanguage("fr");
        const stored = phrase("reviews.rebase.asked", { name: "Rita" });
        expect(wordPhrase(stored)).toBe("Rebase demandé à Rita.");
        setLanguage("en");
        expect(wordPhrase(stored)).toBe("Rebase asked to Rita.");
    });

    it("words nested phrases, wavesrv's coded sentences and caught errors at each call", () => {
        const stored = phrase("reviews.rebase.failed", { message: errorPhrase(new Error(WiredBusy)) });
        const server = serverPhrase({ code: "review.worktreecreate", vars: { branch: "b", detail: "busy" } }, "x");
        setLanguage("fr");
        const fr = wordPhrase(stored);
        expect(fr).toContain("Un worktree sur b n'a pas pu être créé : busy");
        expect(wordPhrase(server)).toBe("Un worktree sur b n'a pas pu être créé : busy");
        setLanguage("en");
        expect(wordPhrase(stored)).not.toBe(fr);
        expect(wordPhrase(stored)).toContain("The rebase could not be asked");
        expect(wordPhrase(serverPhrase({ code: "unknown.code" }, "plain English"))).toBe("plain English");
        expect(wordPhrase(errorPhrase("plain error"))).toBe("plain error");
        expect(wordPhrase(null)).toBe("");
    });

    it("joins phrases, leaving out the missing ones", () => {
        const joined = joinPhrases([
            phrase("reviews.rebase.asked", { name: "Rita" }),
            null,
            phrase("reviews.rebase.inflight"),
        ]);
        setLanguage("en");
        expect(wordPhrase(joined)).toBe(`Rebase asked to Rita. ${wordPhrase(phrase("reviews.rebase.inflight"))}`);
    });

    it("keeps an Ask for a rebase's outcome readable after a language switch", () => {
        setLanguage("fr");
        const outcome = rebaseOutcome({ status: "sent", firstname: "Rita" });
        const failed = markReadyError({ status: "failed", reason: "closed" });
        const frText = wordPhrase(outcome.text);
        const frFailed = wordPhrase(failed);
        setLanguage("en");
        expect(frText).toBe("Rebase demandé à Rita.");
        expect(wordPhrase(outcome.text)).toBe("Rebase asked to Rita.");
        expect(wordPhrase(failed)).not.toBe(frFailed);
        expect(wordPhrase(failed)).toContain("closed");
        expect(markReadyError({ status: "ready" })).toBeNull();
    });
});
