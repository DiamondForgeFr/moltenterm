// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pull request status dots on the block that shows Integration (FR-SHELL-085, #1304): blocked, ready, CI running,
// the agents' turn. Pure, read from the panel's own answer, split and card states, so the dots never disagree with
// the panel's lists and sections.

import type { CardState, CardStateKind } from "../reviews/reviews-card-model";
import {
    checksOf,
    MoltentermReviewsView,
    ReadiedPrs,
    ReviewPr,
    ReviewsAnswer,
    splitReviews,
} from "../reviews/reviews-model";

export type PrCountKind = "blocked" | "ready" | "ci" | "draft";

export type PrCounts = Record<PrCountKind, number>;

// The order the dots read in, top to bottom: the most critical first.
export const PrCountKinds: PrCountKind[] = ["blocked", "ready", "ci", "draft"];

// Tooltip and accessible name keys, a plural each (.one / .other).
export const PrCountKeys: Record<PrCountKind, string> = {
    blocked: "sidebar.prCounts.blocked",
    ready: "sidebar.prCounts.ready",
    ci: "sidebar.prCounts.ci",
    draft: "sidebar.prCounts.draft",
};

// The card states that wait on the developer's decision: an agent stopped on a question, a stopped task, a conflict
// or a failure nobody works on (the card picks an agent at work before them).
const BlockedCards = new Set<CardStateKind>(["agent-waiting", "interrupted", "conflicts", "failing"]);

// The card states that are the agents' turn, like a draft.
const AgentCards = new Set<CardStateKind>(["agent-working", "agent-finish"]);

export function emptyPrCounts(): PrCounts {
    return { blocked: 0, ready: 0, ci: 0, draft: 0 };
}

// Without a card (no agent data), the PR alone: a conflict or a failing CI blocks.
function prKind(pr: ReviewPr): PrCountKind {
    if (pr.draft) {
        return "draft";
    }
    if (pr.merge === "conflicts" || pr.merge === "failing" || checksOf(pr.ci, "failure").length > 0) {
        return "blocked";
    }
    const ci = pr.ci?.state ?? "none";
    if (ci === "pending" || ci === "failure" || pr.merge === "running") {
        return "ci";
    }
    return "ready";
}

// prCountKind: the one dot a PR counts in. With its card (the Integration panel's state for it), the card decides.
export function prCountKind(pr: ReviewPr, card?: CardState): PrCountKind {
    if (card == null) {
        return prKind(pr);
    }
    if (BlockedCards.has(card.kind)) {
        return "blocked";
    }
    if (pr.draft || AgentCards.has(card.kind)) {
        return "draft";
    }
    if (card.kind === "ci-running") {
        return "ci";
    }
    return "ready";
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
