// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews panel's sort (FR-REV-001 AC13, #1061) and the suggested merge order (FR-REV-024): the header's segmented
// control (by state, or by merge order), the line saying what the merge order costs in CI runs, and each card's rank
// and reason. The order itself is reviews-order-model.ts's.

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useT } from "../i18n/i18n";
import type { MergeOrderHeader } from "./reviews-order-model";
import { ReviewsSortPref } from "./reviews-order-store";
import type { ReviewsSort } from "./reviews-sections-model";

// What a row shows of the order: its rank and why it takes it; no rank when it is left out of the order (#1059).
export type RowOrder = { rank: number; reason: string };

// "To learn" joins with the learning grades (#788, #1064).
const Sorts: { sort: ReviewsSort; label: string; title: string }[] = [
    { sort: "state", label: "reviews.sort.state", title: "reviews.sort.stateTitle" },
    { sort: "merge", label: "reviews.sort.merge", title: "reviews.order.suggestedTitle" },
];

export function useReviewsSort(): ReviewsSort {
    return useAtomValue(ReviewsSortPref.getInstance().sortAtom);
}

// The header's segmented sort control; it replaces the order bar above the list.
export function SortControl({ sort }: { sort: ReviewsSort }) {
    const t = useT();
    return (
        <span
            role="group"
            aria-label={t("reviews.sort.aria")}
            className="inline-flex shrink-0 overflow-hidden rounded-4 border border-border"
            data-testid="reviews-sort"
        >
            {Sorts.map((s, i) => {
                const on = s.sort === sort;
                return (
                    <button
                        key={s.sort}
                        type="button"
                        aria-pressed={on}
                        title={t(s.title)}
                        onClick={() => ReviewsSortPref.getInstance().set(s.sort)}
                        className={cn(
                            "cursor-pointer px-2 py-0.5 text-11 leading-4 whitespace-nowrap transition-colors duration-120 ease-mt",
                            i > 0 && "border-l border-border",
                            on ? "bg-hover text-primary" : "text-muted hover:bg-hover/60 hover:text-primary"
                        )}
                        data-testid={`reviews-sort-${s.sort}`}
                    >
                        {t(s.label)}
                    </button>
                );
            })}
        </span>
    );
}

// What the merge order shown costs, while it is chosen.
export function MergeOrderCost({ header }: { header: MergeOrderHeader }) {
    return (
        <div className="flex min-w-0 items-center" data-testid="reviews-order">
            {header?.text ? (
                <span
                    className={cn(
                        "min-w-0 truncate text-11",
                        header.kind === "uptodate" ? "text-warning" : "text-secondary"
                    )}
                    title={header.title}
                    aria-live="polite"
                    data-testid="reviews-order-cost"
                    data-kind={header.kind}
                >
                    {header.text}
                </span>
            ) : null}
        </div>
    );
}

export function MergeOrderRank({ order }: { order: RowOrder }) {
    const t = useT();
    if (order?.rank == null) {
        return null;
    }
    return (
        <span
            className="mr-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-4 border border-accent/50 bg-accent/10 px-1 align-[1px] text-10 leading-none font-semibold text-accent tabular-nums"
            title={t("reviews.order.rankTitle", { rank: order.rank })}
            data-testid="reviews-order-rank"
        >
            {order.rank}
        </span>
    );
}

export function MergeOrderReason({ order }: { order: RowOrder }) {
    if (!order?.reason) {
        return null;
    }
    return (
        <div
            className="truncate text-11 leading-4 text-secondary"
            title={order.reason}
            data-testid="reviews-order-reason"
        >
            {order.reason}
        </div>
    );
}
