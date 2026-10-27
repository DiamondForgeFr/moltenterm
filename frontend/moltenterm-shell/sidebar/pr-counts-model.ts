// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pull request counts under the block that shows Pilotage (FR-SHELL-085): ready, CI running or failing, draft.
// Pure, read from Pilotage's own answer and split, so the counts never disagree with the panel's lists.

import { MoltentermReviewsView, ReadiedPrs, ReviewPr, ReviewsAnswer, splitReviews } from "../reviews/reviews-model";

export type PrCountKind = "ready" | "ci" | "draft";

export type PrCounts = Record<PrCountKind, number>;

// The order the pills read in, left to right.
export const PrCountKinds: PrCountKind[] = ["ready", "ci", "draft"];

// Tooltip keys, a plural each (.one / .other).
export const PrCountKeys: Record<PrCountKind, string> = {
    ready: "sidebar.prCounts.ready",
    ci: "sidebar.prCounts.ci",
    draft: "sidebar.prCounts.draft",
};

function ciBusy(pr: ReviewPr): boolean {
    const ci = pr.ci?.state ?? "none";
    return ci === "pending" || ci === "failure" || pr.merge === "running" || pr.merge === "failing";
}

// prCounts: a PR waiting for review whose CI still runs or fails counts as CI, the other ones as ready; drafts as
// drafts. Nothing while GitHub could not be read: no counts then.
export function prCounts(answer: ReviewsAnswer, readied?: ReadiedPrs): PrCounts {
    const counts: PrCounts = { ready: 0, ci: 0, draft: 0 };
    if (answer?.state !== "ok") {
        return counts;
    }
    const split = splitReviews(answer, readied);
    for (const pr of split.ready) {
        counts[ciBusy(pr) ? "ci" : "ready"]++;
    }
    counts.draft = split.drafts.length;
    return counts;
}

export function hasPrCounts(counts: PrCounts): boolean {
    return counts != null && PrCountKinds.some((kind) => counts[kind] > 0);
}

// A count as its pill shows it: past 99 the pill would outgrow a block.
export function prCountText(count: number): string {
    return count > 99 ? "99+" : String(count);
}

export type ViewBlocks = { tabId: string; views: string[] };

// firstPilotageTab: one place per area carries the counts, the first of its blocks whose view holds a Pilotage panel.
export function firstPilotageTab(tabs: ViewBlocks[]): string {
    return tabs.find((tab) => tab.views.includes(MoltentermReviewsView))?.tabId ?? "";
}
