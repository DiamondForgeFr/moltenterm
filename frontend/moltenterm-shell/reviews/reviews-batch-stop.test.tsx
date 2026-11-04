// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { BatchStopLine } from "./reviews-batch";
import { BatchItem, batchRetryRequest, batchRowMark, BatchRun, batchStopHelp } from "./reviews-batch-model";

const Gh502 = "gh pr merge 1864 --rebase --match-head-commit abc: non-200 OK status code: 502 Bad Gateway";

function item(extra: Partial<BatchItem> = {}): BatchItem {
    return {
        number: 1864,
        headref: "fix/1864-x",
        headoid: "a".repeat(40),
        valid: "b".repeat(40),
        title: "PR 1864",
        ticket: 1860,
        method: "rebase",
        source: "validate",
        state: "stopped",
        ...extra,
    };
}

function run(items: BatchItem[], extra: Partial<BatchRun> = {}): BatchRun {
    return {
        id: "r1",
        dir: "/p",
        repo: "a/b",
        base: "develop",
        state: "done",
        current: -1,
        items,
        ciruns: 0,
        startedat: 1,
        ...extra,
    };
}

describe("a PR the merge queue stopped (#1871)", () => {
    beforeEach(() => {
        I18nModel.getInstance().setLanguageSetting("en");
    });

    it("says GitHub did not answer, offers Try again and GitHub's status, the raw error behind Details", () => {
        const help = batchStopHelp(item({ reason: "unavailable", status: 502, detail: Gh502 }), "develop");
        expect(help).toEqual({
            sentence: "GitHub did not answer (error 502): nothing was merged. Try again once GitHub is back.",
            action: "retry",
            outage: true,
            detail: Gh502,
        });
        expect(batchStopHelp(item({ reason: "unavailable" }), "develop").sentence).toBe(
            "GitHub did not answer in time: nothing was merged. Try again once GitHub is back."
        );
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(batchStopHelp(item({ reason: "unavailable", status: 502 }), "develop").sentence).toBe(
            "GitHub n'a pas répondu (erreur 502) : rien n'a été fusionné. Réessayez quand GitHub sera revenu."
        );
    });

    it("gives each stop its sentence and its action", () => {
        const cases: [Partial<BatchItem>, string][] = [
            [{ reason: "conflict" }, "rebase"],
            [{ reason: "ambiguous" }, "rebase"],
            [{ reason: "headmoved" }, "revalidate"],
            [{ reason: "warnings" }, "revalidate"],
            [{ reason: "failing", state: "failed", names: ["ci"] }, "ci"],
            [{ reason: "citimeout" }, "ci"],
            [{ reason: "blocked" }, "github"],
            [{ reason: "mergefailed", detail: "HTTP 422", code: "mergeerror" }, "retry"],
            [{ reason: "draft" }, null],
        ];
        for (const [extra, action] of cases) {
            const help = batchStopHelp(item(extra), "develop");
            expect(help.action, extra.reason).toBe(action);
            expect(help.sentence, extra.reason).not.toBe("");
            expect(help.outage, extra.reason).toBe(false);
        }
        const failed = batchStopHelp(
            item({ reason: "mergefailed", detail: "HTTP 422: Unprocessable", code: "mergeerror" }),
            "develop"
        );
        expect(failed.sentence).toBe("GitHub refused the merge: nothing was merged.");
        expect(failed.detail).toBe("HTTP 422: Unprocessable mergeerror");
        expect(batchStopHelp(item({ state: "merged" }), "develop")).toBeNull();
    });

    it("puts the stopped mark's explanation on the row", () => {
        const mark = batchRowMark(run([item({ reason: "unavailable", status: 502 })]), 1864);
        expect(mark.label).toBe("Needs you");
        expect(mark.stop.action).toBe("retry");
        expect(mark.item.number).toBe(1864);
    });

    it("tries the PR again alone, bound to the commit validated, with its method", () => {
        const stopped = item({ reason: "unavailable", status: 502 });
        const other = item({ number: 1865, state: "merged" });
        const req = batchRetryRequest(run([stopped, other]), stopped, "ws", [1864]);
        expect(req).toMatchObject({
            dir: "/p",
            repo: "a/b",
            base: "develop",
            method: "rebase",
            source: "validate",
            order: [1864],
            workspaceid: "ws",
        });
        expect(req.prs).toEqual([
            {
                number: 1864,
                headref: "fix/1864-x",
                headoid: "b".repeat(40),
                title: "PR 1864",
                url: undefined,
                ticket: 1860,
                method: "rebase",
            },
        ]);
    });

    it("draws the sentence, Try again, GitHub's status and Details", () => {
        const mark = batchRowMark(run([item({ reason: "unavailable", status: 502, detail: Gh502 })]), 1864);
        const html = renderToStaticMarkup(
            <BatchStopLine
                mark={mark}
                number={1860}
                base="develop"
                busy={false}
                onAction={() => {}}
                onOpenLink={() => {}}
            />
        );
        expect(html).toContain("GitHub did not answer (error 502)");
        expect(html).toContain('data-action="retry"');
        expect(html).toContain(">Try again<");
        expect(html).toContain("GitHub status");
        expect(html).toContain(">Details<");
        expect(html).not.toContain("Bad Gateway");
    });
});
