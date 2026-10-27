// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The merge queue block, the status line after a merge, and a card's place in the queue (#1062).

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import { phrase } from "../i18n/phrase";
import { ReviewCheck, ReviewPr } from "./reviews-model";
import { AfterMergeLine, MergeOrderNote, MergeQueueBlock, QueuedAskLine } from "./reviews-queue";
import type { MergeQueue, OrderNote } from "./reviews-queue-model";
import { ReviewRow } from "./reviews-view";

const Green: ReviewCheck[] = [{ name: "Backend", state: "success" }];

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
        ci: { state: "success", success: 1, failure: 0, pending: 0, checks: Green },
        report: { state: "present" },
        unpublished: 0,
        ...extra,
    };
}

const Queue: MergeQueue = {
    usable: true,
    steps: [
        { number: 1206, rank: 0, rebase: false, wait: false, rebaseAfter: [], before: [], merged: true },
        { number: 1201, rank: 1, rebase: false, wait: false, rebaseAfter: [], before: [1202] },
        { number: 1202, rank: 2, rebase: true, wait: false, rebaseAfter: [1201], before: [] },
        { number: 1205, rank: 3, rebase: false, wait: true, rebaseAfter: [], before: [] },
    ],
    outside: [1207],
    cost: 1,
    listCost: 2,
    uptodate: "notrequired",
};

function rowHtml(p: ReviewPr, extra: Partial<Parameters<typeof ReviewRow>[0]> = {}): string {
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
            {...extra}
        />
    );
}

describe("merge queue views (#1062)", () => {
    beforeAll(() => I18nModel.getInstance().setLanguageSetting("en"));
    afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

    it("shows the numbered steps, the cost, the legend, and Merge in this order last, at the right", () => {
        const html = renderToStaticMarkup(
            <MergeQueueBlock
                queue={Queue}
                prs={[pr(1201), pr(1202), pr(1205)]}
                base="develop"
                status={{ kind: "ready", text: "", title: "" }}
                hot={[1202]}
                canMerge
                free
                onChoose={() => {}}
                onStep={() => {}}
                onMerge={() => {}}
            />
        );
        expect(html).toContain("Suggested order");
        expect(html).toContain("1 rebase instead of 2 in list order");
        expect(html.match(/data-testid="reviews-queue-step"/g)).toHaveLength(4);
        expect(html).toContain('data-step="1206" data-merged="true"');
        expect(html).toContain('data-step="1202" data-hot="true"');
        expect(html).toContain("⟲");
        expect(html).toContain("◔");
        expect(html).toContain("#1207 out of the queue: already conflicts with develop");
        // The CTA comes after the steps and the legend (developer decision 2026-10-24), in a right-aligned row.
        const cta = html.indexOf('data-testid="reviews-queue-merge"');
        expect(cta).toBeGreaterThan(html.indexOf('data-testid="reviews-queue-legend"'));
        expect(html.slice(0, cta)).toMatch(/justify-end[^>]*>\s*<button[^>]*$/);
        expect(html).toContain("Merge these 3 in this order…");
        expect(html).toContain("molten-btn");
    });

    it("offers no CTA while the running queue already holds every step", () => {
        const html = renderToStaticMarkup(
            <MergeQueueBlock
                queue={Queue}
                prs={[]}
                base="develop"
                status={null}
                hot={[]}
                canMerge={false}
                free={false}
                onChoose={() => {}}
                onStep={() => {}}
                onMerge={() => {}}
            />
        );
        expect(html).not.toContain("reviews-queue-merge");
    });

    it("says what changed after a merge, with Hand the rebase over and Later", () => {
        const html = renderToStaticMarkup(
            <AfterMergeLine
                after={{
                    merged: [1206, 1201],
                    needs: [{ number: 1202, after: 1201, paths: ["a"], pathcount: 1 }],
                    read: 1,
                }}
                busy={false}
                onHandOver={() => {}}
                onClose={() => {}}
            />
        );
        expect(html).toContain(
            "✓ #1206 and #1201 merged. #1202 touches the same lines as #1201: it now needs a rebase."
        );
        expect(html).toContain("Hand the rebase over");
        expect(html).toContain("Later");
        const none = renderToStaticMarkup(
            <AfterMergeLine
                after={{ merged: [1206], needs: [], read: 1 }}
                busy={false}
                onHandOver={() => {}}
                onClose={() => {}}
            />
        );
        expect(none).toContain("✓ #1206 merged. No other pull request needs a rebase.");
        expect(none).not.toContain("Hand the rebase over");
    });

    it("gives a queued card its rank and its place in the order; every step's Validate looks the same (#1108)", () => {
        const first = rowHtml(pr(1201), { rank: 1, queueWhy: phrase("reviews.queue.why.before", { prs: "#1202" }) });
        expect(first).toContain('data-testid="reviews-order-rank"');
        expect(first).toContain("Ready to merge<span");
        expect(first).toContain("· before #1202");
        expect(first).toContain('data-molten="true"');
        const later = rowHtml(pr(1202), {
            rank: 2,
            queueWhy: phrase("reviews.queue.why.rebaseAfter", { prs: "#1201" }),
        });
        expect(later).toContain("· to rebase after #1201");
        // The order is a proposal for the group merge (developer decision 2026-10-25): any ready PR may be validated
        // first, so no step's Validate is styled differently.
        expect(later).toContain('data-molten="true"');
        expect(later.match(/data-testid="reviews-card-primary"[^>]*>/)[0]).toBe(
            first.match(/data-testid="reviews-card-primary"[^>]*>/)[0]
        );
    });

    it("shows a card's conflicts at rest and its tag while linked to the hovered card", () => {
        const html = rowHtml(pr(1202), {
            relation: {
                fact: phrase("reviews.queue.fact.sameLines", { prs: "#1201", paths: "src/theme.ts" }),
                role: "linked",
                tag: phrase("reviews.queue.tag.paths", { number: 1201, paths: "src/theme.ts" }),
            },
        });
        expect(html).toContain('data-relation="linked"');
        expect(html).toContain("same lines as #1201: src/theme.ts");
        expect(html).toContain("⇄ conflict with #1201 · src/theme.ts");
    });

    it("shows a task queued for a busy agent, with Cancel", () => {
        const ask = {
            dir: "/p",
            repo: "a/b",
            pr: pr(1202),
            kind: "rebase" as const,
            agent: { blockId: "b", name: "Nathan" },
            at: 1,
        };
        const html = renderToStaticMarkup(<QueuedAskLine ask={ask} />);
        expect(html).toContain("Rebase queued for Nathan, after its task");
        expect(html).toContain("Cancel");
        const failed = renderToStaticMarkup(
            <QueuedAskLine ask={{ ...ask, failed: phrase("reviews.queue.ask.prGone", { number: 1202 }) }} />
        );
        expect(failed).toContain('data-state="failed"');
        expect(failed).toContain("Dismiss");
    });
});

describe("choosing the group merge and one number per card (#1108)", () => {
    beforeAll(() => I18nModel.getInstance().setLanguageSetting("en"));
    afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

    const Chosen: MergeQueue = {
        usable: true,
        steps: [
            { number: 1096, rank: 1, rebase: false, wait: false, rebaseAfter: [], before: [] },
            { number: 1094, rank: 2, rebase: false, wait: false, rebaseAfter: [], before: [] },
        ],
        outside: [],
        cost: 0,
        listCost: 0,
        uptodate: "notrequired",
        out: [1090],
        ids: { 1096: 1091, 1094: 1092, 1090: 1088 },
    };

    function block(queue: MergeQueue, canMerge = true) {
        return renderToStaticMarkup(
            <MergeQueueBlock
                queue={queue}
                prs={[pr(1096, { ticket: 1091 }), pr(1094, { ticket: 1092 }), pr(1090, { ticket: 1088 })]}
                base="develop"
                status={null}
                hot={[]}
                canMerge={canMerge}
                free
                onStep={() => {}}
                onChoose={() => {}}
                onMerge={() => {}}
            />
        );
    }

    it("names the steps by their cards' numbers, checks the chosen ones and keeps the taken-out one to put back", () => {
        const html = block(Chosen);
        expect(html).toContain("#1091");
        expect(html).toContain("#1092");
        expect(html).not.toContain("#1096");
        expect(html.match(/role="checkbox" aria-checked="true"/g)).toHaveLength(2);
        expect(html).toContain('aria-label="Take #1091 out of the group merge"');
        expect(html).toContain('data-step="1090" data-out="true"');
        expect(html).toContain('role="checkbox" aria-checked="false" aria-label="Add #1088 to the group merge"');
        expect(html.indexOf('data-step="1090"')).toBeGreaterThan(html.indexOf('data-step="1094"'));
        expect(html).toContain("Merge these 2 in this order…");
    });

    it("gives way to a line when fewer than two are chosen", () => {
        const one = block({ ...Chosen, steps: Chosen.steps.slice(0, 1), out: [1094, 1090] }, false);
        expect(one).not.toContain("reviews-queue-merge");
        expect(one).toContain("One pull request chosen: its card&#x27;s Validate merges it.");
        const none = block({ ...Chosen, steps: [], out: [1096, 1094, 1090] }, false);
        expect(none).toContain("No pull request chosen for the group merge.");
    });

    it("shows the ticket as the card's number and the PR as a chip; the PR's own number without a ticket", () => {
        const html = rowHtml(pr(1096, { ticket: 1091, tickettitle: "Queue selection" }));
        expect(html).toMatch(/data-testid="reviews-card-number">#1091</);
        expect(html).toMatch(/data-testid="reviews-card-pr">PR #1096</);
        const bare = rowHtml(pr(1096));
        expect(bare).toMatch(/data-testid="reviews-card-number">#1096</);
        expect(bare).not.toContain('data-testid="reviews-card-pr"');
    });
});

describe("merge order note (#1172)", () => {
    beforeAll(() => I18nModel.getInstance().setLanguageSetting("en"));
    afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));

    const note: OrderNote = {
        count: 1,
        steps: [{ number: 1162, rank: 1, rebase: false, wait: false, rebaseAfter: [], before: [] }],
        out: [],
        drafts: [{ number: 1161, after: [1162] }],
        hasDrafts: true,
    };
    const ids = { 1162: 1150, 1161: 1152 };
    const prs = [pr(1162, { ticket: 1150 }), pr(1161, { ticket: 1152, draft: true })];

    it("says why there is no order, numbers the one step and greys the draft at its place", () => {
        const html = renderToStaticMarkup(
            <MergeOrderNote note={note} prs={prs} ids={ids} status={null} onStep={() => {}} />
        );
        expect(html).toContain("Only one pull request can merge: no order to suggest.");
        expect(html).toContain("Drafts join the order once ready for review.");
        expect(html).toMatch(/data-testid="reviews-order-note-step" data-step="1162">.*1<\/span>#1150/);
        expect(html).toContain("#1152 draft · after #1150");
        expect(html).not.toContain('data-testid="reviews-queue-merge"');
    });

    it("shows nothing while the numbered block shows", () => {
        expect(
            renderToStaticMarkup(<MergeOrderNote note={null} prs={prs} ids={ids} status={null} onStep={() => {}} />)
        ).toBe("");
    });

    it("reads in French", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        try {
            const html = renderToStaticMarkup(
                <MergeOrderNote note={note} prs={prs} ids={ids} status={null} onStep={() => {}} />
            );
            expect(html).toContain("Une seule pull request prête à fusionner : pas d&#x27;ordre à proposer.");
            expect(html).toContain("#1152 brouillon · après #1150");
        } finally {
            I18nModel.getInstance().setLanguageSetting("en");
        }
    });
});
