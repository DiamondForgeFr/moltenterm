// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A Reviews card (#1060, FR-REV-001 AC11): its state's rail, sentence and one primary action, the "…" menu, the facts
// line and the draft tag.

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { ReviewCheck, ReviewPr } from "./reviews-model";
import { ReviewRow } from "./reviews-view";

const Green: ReviewCheck[] = [
    { name: "Backend", state: "success" },
    { name: "Build", state: "success" },
];

function pr(number: number, extra: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number,
        title: `PR ${number}`,
        url: `https://github.com/a/b/pull/${number}`,
        branch: `feature/${number}-x`,
        base: "develop",
        createdat: "2026-10-10T10:00:00Z",
        updatedat: "2026-10-12T10:00:00Z",
        merge: "clean",
        ci: { state: "success", success: 2, failure: 0, pending: 0, checks: Green },
        report: { state: "present" },
        unpublished: 0,
        ...extra,
    };
}

function rowHtml(p: ReviewPr): string {
    return renderToStaticMarkup(
        <ReviewRow
            pr={p}
            selected={false}
            marked={false}
            onSelect={() => {}}
            onOpen={() => {}}
            onValidate={() => {}}
            onAskRebase={async () => null}
            onInvestigate={async () => null}
            rebaseAsk={null}
            dir="/p"
            repo="a/b"
        />
    );
}

function primary(html: string): string {
    return /<button[^>]*data-testid="reviews-card-primary"[^>]*>.*?<\/button>/.exec(html)?.[0] ?? "";
}

describe("Reviews card (#1060)", () => {
    it("a ready PR: green rail, Ready to merge, Validate as the one molten button, a menu", () => {
        const html = rowHtml(pr(12));
        expect(html).toContain('data-state="ready"');
        expect(html).toContain("background:var(--mt-state-done)");
        expect(html).toContain("Ready to merge");
        const button = primary(html);
        expect(button).toContain('data-action="validate"');
        expect(button).toContain("molten-btn");
        expect(button).toContain("Validate");
        expect(html.match(/molten-btn\b(?!-)/g)).toHaveLength(1);
        expect(html).toContain('data-testid="reviews-card-more"');
        expect(html).toContain('aria-label="More actions on PR #12"');
        expect(html).not.toContain('data-testid="reviews-github"');
        expect(html).not.toContain('data-testid="reviews-launch"');
    });

    it("says each fact once, muted, without the chip row", () => {
        const html = rowHtml(pr(12, { merge: "behind" }));
        expect(html).toContain("CI 2/2");
        expect(html).toContain("behind develop, GitHub will update it");
        expect(html).not.toContain('data-testid="reviews-ci"');
        expect(html).not.toContain('data-testid="reviews-merge"');
    });

    it("a draft carries a small tag and Mark ready for review", () => {
        const html = rowHtml(pr(13, { draft: true }));
        expect(html).toContain('data-testid="reviews-draft-tag"');
        expect(html).toContain('data-state="draft-ready"');
        expect(primary(html)).toContain("Mark ready for review");
        expect(html).not.toContain('data-testid="reviews-validate"');
    });

    it("a failed CI: red rail, the failure named once, Analyze and resolve, no Rerun beside it", () => {
        const html = rowHtml(
            pr(5, {
                merge: "failing",
                ci: {
                    state: "failure",
                    success: 1,
                    failure: 1,
                    pending: 0,
                    checks: [{ name: "Backend", state: "failure", runid: 3, jobid: 7 }, Green[1]],
                },
            })
        );
        expect(html).toContain('data-state="failing"');
        expect(html).toContain("background:var(--mt-state-error)");
        const facts = /data-testid="reviews-card-facts".*?<\/div>/.exec(html)?.[0] ?? "";
        expect(/data-testid="reviews-card-state".*?<\/div>/.exec(html)?.[0]).toContain("CI failing: Backend");
        expect(facts).not.toContain("Backend");
        expect(facts).toContain("1 other checks green");
        expect(primary(html)).toContain("Analyze and resolve");
        expect(html).not.toContain('data-testid="reviews-rerun"');
    });

    it("no Analyze and resolve on a PR only behind, or only missing its report", () => {
        expect(rowHtml(pr(6, { merge: "behind" }))).not.toContain("Analyze and resolve");
        expect(rowHtml(pr(6, { report: { state: "missing" } }))).not.toContain("Analyze and resolve");
    });

    it("review required: amber, Assisted review, Validate only in the menu", () => {
        const html = rowHtml(pr(7, { merge: "blocked", reviewdecision: "REVIEW_REQUIRED" }));
        expect(html).toContain("background:var(--mt-state-waiting)");
        expect(html).toContain("Review required");
        expect(primary(html)).toContain('data-action="assisted-review"');
    });

    it("CI running: grey, a calm Assisted review, no molten button", () => {
        const html = rowHtml(
            pr(8, {
                ci: {
                    state: "pending",
                    success: 1,
                    failure: 0,
                    pending: 1,
                    checks: [{ name: "Backend", state: "pending" }, Green[1]],
                },
            })
        );
        expect(html).toContain('data-state="ci-running"');
        expect(html).not.toContain("molten-btn");
        expect(primary(html)).toContain("Assisted review");
    });

    it("conflicts: one action, Hand the rebase over", () => {
        const html = rowHtml(pr(9, { merge: "conflicts" }));
        expect(primary(html)).toContain("Hand the rebase over");
        expect(html).not.toContain("Ask for a rebase");
        expect(html).not.toContain("Analyze and resolve");
    });

    it("the card's accessible name carries its state and facts", () => {
        const html = rowHtml(pr(12));
        expect(html).toMatch(/aria-label="PR 12, pull request #12, Ready to merge, CI 2\/2, report"/);
    });

    describe("in French", () => {
        beforeAll(() => I18nModel.getInstance().setLanguageSetting("fr"));
        afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));
        it("words the card", () => {
            const html = rowHtml(pr(13, { draft: true }));
            expect(html).toContain("Prête à passer en revue");
            expect(html).toContain(">brouillon<");
            expect(primary(html)).toContain("Passer en revue");
        });
    });
});
