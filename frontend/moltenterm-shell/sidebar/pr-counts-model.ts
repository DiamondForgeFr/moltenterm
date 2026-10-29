// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pull request status dots on the block that shows Integration (FR-SHELL-085, #1304; FR-SHELL-098, #1327): one
// dot per section of the panel, named and counted as the section is. A PR counts under the dot of the section its
// card is listed in (the card's turn), so the dots never disagree with the panel's lists and sections. Pure.

import { CardState, cardState, CardTurn, TurnTitleKeys } from "../reviews/reviews-card-model";
import { MoltentermReviewsView, ReadiedPrs, ReviewPr, ReviewsAnswer, splitReviews } from "../reviews/reviews-model";

export type PrCountKind = CardTurn;

export type PrCounts = Record<PrCountKind, number>;

// The order the dots read in, top to bottom: the most critical first.
export const PrCountKinds: PrCountKind[] = ["blocked", "yours", "ready", "waiting", "agents"];

// A dot's tooltip and accessible name: the section's title (the panel's own words) and the count, a plural
// (.one / .other).
export const PrCountKey = "sidebar.prCounts.line";

// The key of the section title a dot is named after.
export function prCountSectionKey(kind: PrCountKind): string {
    return TurnTitleKeys[kind];
}

export function emptyPrCounts(): PrCounts {
    return { blocked: 0, yours: 0, ready: 0, waiting: 0, agents: 0 };
}

// prCountKind: the one dot a PR counts in. With its card (the Integration panel's state for it), the card decides;
// without one (no agent data yet) the PR alone is read through the same card model, with no agent on its branch.
export function prCountKind(pr: ReviewPr, card?: CardState): PrCountKind {
    return (card ?? cardState({ pr, agents: [] })).turn;
}

// prCounts: every PR the panel lists, ready group and drafts, counted once. Nothing while GitHub could not be read.
export function prCounts(answer: ReviewsAnswer, readied?: ReadiedPrs, cards?: Record<number, CardState>): PrCounts {
    const counts = emptyPrCounts();
    if (answer?.state !== "ok") {
        return counts;
    }
    const split = splitReviews(answer, readied);
    for (const pr of [...split.ready, ...split.drafts]) {
        counts[prCountKind(pr, cards?.[pr.number])]++;
    }
    return counts;
}

export function hasPrCounts(counts: PrCounts): boolean {
    return counts != null && PrCountKinds.some((kind) => counts[kind] > 0);
}

// The kinds that show a dot, in their order.
export function shownPrKinds(counts: PrCounts): PrCountKind[] {
    if (counts == null) {
        return [];
    }
    return PrCountKinds.filter((kind) => counts[kind] > 0);
}

export type ViewBlocks = { tabId: string; views: string[] };

// firstPilotageTab: one place per area carries the dots, the first of its blocks whose view holds the panel.
export function firstPilotageTab(tabs: ViewBlocks[]): string {
    return tabs.find((tab) => tab.views.includes(MoltentermReviewsView))?.tabId ?? "";
}
