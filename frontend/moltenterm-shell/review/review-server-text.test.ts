// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The review service's sentences in the interface language (#656): wavesrv's codes are worded by the window, its
// English stays the fallback.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { errorPhrase, wordPhrase } from "../i18n/phrase";
import { rebaseOutcome as outcomeOf } from "../reviews/reviews-model";
import { validateErrorText } from "./review-merge";
import { restartOutcome } from "./review-restart";

// The outcome with its text worded, as a row shows it (#1058).
function rebaseOutcome(
    result: Parameters<typeof outcomeOf>[0],
    error?: string,
    what?: Parameters<typeof outcomeOf>[2]
) {
    const outcome = outcomeOf(result, error == null ? null : errorPhrase(error), what);
    return outcome == null ? outcome : { ...outcome, text: wordPhrase(outcome.text) };
}

const Wired = 'uimsg:{"code":"review.nothingtopublish"}\nthere is nothing to publish: stage comments first';
const WiredWorktree =
    'uimsg:{"code":"review.worktreecreate","vars":{"branch":"feature/1-x","detail":"fatal: busy"}}\na worktree on feature/1-x could not be created: fatal: busy';

describe("review sentences in French", () => {
    beforeAll(() => I18nModel.getInstance().setLanguageSetting("fr"));
    afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

    it("words a coded error of the service", () => {
        expect(validateErrorText(Wired)).toBe("Il n'y a rien à publier : marquez d'abord des commentaires prêts.");
        expect(validateErrorText("gh: HTTP 502")).toBe("gh: HTTP 502");
    });

    it("words a restart or rebase result's detail", () => {
        const result = {
            status: "failed" as const,
            reason: "worktree",
            branch: "feature/1-x",
            message: "a worktree on feature/1-x could not be created: fatal: busy",
            messagetext: { code: "review.worktreecreate", vars: { branch: "feature/1-x", detail: "fatal: busy" } },
        };
        expect(restartOutcome(result)).toContain("Un worktree sur feature/1-x n'a pas pu être créé : fatal: busy");
        expect(rebaseOutcome(result).text).toContain("Un worktree sur feature/1-x n'a pas pu être créé : fatal: busy");
        expect(restartOutcome(null, "Restart failed")).toContain("Restart failed");
    });

    it("keeps the English for a code it does not know", () => {
        expect(validateErrorText('uimsg:{"code":"review.unknowncode"}\nplain English')).toBe("plain English");
        expect(validateErrorText(WiredWorktree)).toContain("fatal: busy");
    });
});
