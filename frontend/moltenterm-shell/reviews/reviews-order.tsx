// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The suggested merge order in the Reviews list (FR-REV-024): the switch between the suggested order and the list's
// own, the line saying what the order shown costs in CI runs, and each row's rank and reason. The order itself is
// reviews-order-model.ts's.

import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useT } from "../i18n/i18n";
import type { MergeOrderHeader } from "./reviews-order-model";
import { MergeOrderChoice, MergeOrderPref } from "./reviews-order-store";

// What a row shows of the order: its rank and why it takes it.
export type RowOrder = { rank: number; reason: string };

const Choices: { choice: MergeOrderChoice; label: string; title: string }[] = [
    { choice: "suggested", label: "reviews.order.suggested", title: "reviews.order.suggestedTitle" },
    { choice: "list", label: "reviews.order.list", title: "reviews.order.listTitle" },
];

export function useMergeOrderChoice(): MergeOrderChoice {
    return useAtomValue(MergeOrderPref.getInstance().choiceAtom);
}

export function MergeOrderBar({ choice, header }: { choice: MergeOrderChoice; header: MergeOrderHeader }) {
    const t = useT();
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-testid="reviews-order">
            <span role="group" aria-label={t("reviews.order.aria")} className="inline-flex shrink-0 gap-1">
                {Choices.map((c) => {
                    const on = c.choice === choice;
                    return (
                        <button
                            key={c.choice}
                            type="button"
                            aria-pressed={on}
                            title={t(c.title)}
                            onClick={() => MergeOrderPref.getInstance().set(c.choice)}
                            className={cn(
                                "inline-flex cursor-pointer items-center gap-1 rounded-4 border px-1.5 py-0.5 text-11 leading-4 transition-colors duration-120 ease-mt",
                                on
                                    ? "border-accent/60 bg-accent/15 text-primary"
                                    : "border-border text-secondary hover:bg-hover hover:text-primary"
                            )}
                            data-testid={`reviews-order-${c.choice}`}
                        >
                            {c.choice === "suggested" ? (
                                <i className="fa fa-solid fa-arrow-down-1-9 text-10" aria-hidden />
                            ) : null}
                            {t(c.label)}
                        </button>
                    );
                })}
            </span>
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
    if (order == null) {
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
