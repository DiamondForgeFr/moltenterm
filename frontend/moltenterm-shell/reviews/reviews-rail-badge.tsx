// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews icon's counts in the rail (#688), in the Sessions badge's style: the PRs waiting for review at the top
// right, those of them ready to merge at the bottom right in the success colour. A count of 0 draws nothing. The
// icon's accessible name carries the counts (reviewsRailLabel): the badges are hidden from screen readers.

import { cn } from "@/util/util";
import { railCountText, ReviewCounts } from "./reviews-model";

const Badge =
    "absolute right-0 min-w-[14px] rounded-full px-[3px] text-center text-11 leading-[14px] font-semibold ring-2 ring-[var(--color-background)]";

export function ReviewsRailBadges({ counts }: { counts: ReviewCounts }) {
    const waiting = counts?.waiting ?? 0;
    const mergeable = counts?.mergeable ?? 0;
    return (
        <>
            {waiting > 0 ? (
                <span
                    className={cn(Badge, "molten-reviews-waiting top-0 bg-[var(--mt-state-working)] text-black")}
                    aria-hidden="true"
                >
                    {railCountText(waiting)}
                </span>
            ) : null}
            {mergeable > 0 ? (
                <span
                    className={cn(Badge, "molten-reviews-mergeable bottom-0 bg-success text-black")}
                    aria-hidden="true"
                >
                    {railCountText(mergeable)}
                </span>
            ) : null}
        </>
    );
}
