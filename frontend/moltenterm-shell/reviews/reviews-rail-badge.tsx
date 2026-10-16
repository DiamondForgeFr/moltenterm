// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews icon's counts in the rail (#688, #775), in the Sessions badge's style: the PRs waiting for review that
// cannot merge yet at the top right, those that can merge now at the bottom right in the success colour. The two add
// up to the PRs waiting for review. A count of 0 draws nothing. The icon's accessible name carries the counts
// (reviewsRailLabel): the badges are hidden from screen readers.

import { cn } from "@/util/util";
import { railCountText, ReviewCounts } from "./reviews-model";

const Badge =
    "absolute right-0 min-w-[14px] rounded-full px-[3px] text-center text-11 leading-[14px] font-semibold ring-2 ring-[var(--color-background)]";

export function ReviewsRailBadges({ counts }: { counts: ReviewCounts }) {
    const toreview = counts?.toreview ?? 0;
    const mergeable = counts?.mergeable ?? 0;
    return (
        <>
            {toreview > 0 ? (
                <span
                    className={cn(Badge, "molten-reviews-toreview top-0 bg-[var(--mt-state-working)] text-black")}
                    aria-hidden="true"
                >
                    {railCountText(toreview)}
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
