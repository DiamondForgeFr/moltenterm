// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews icon's counts in the rail (#688, #775), in the Sessions badge's style: the PRs waiting for review that
// cannot merge yet at the top right, those that can merge now at the bottom right in the success colour. The two add
// up to the PRs waiting for review. The open drafts (#934) sit on the left in a neutral grey. A count of 0 draws
// nothing. The icon's accessible name carries the counts (reviewsRailLabel): the badges are hidden from screen
// readers.

import { cn } from "@/util/util";
import { railCountText, ReviewCounts } from "./reviews-model";

const Badge =
    "absolute min-w-[14px] rounded-full px-[3px] text-center text-11 leading-[14px] font-semibold ring-2 ring-[var(--color-background)]";

// The icon is 36 px wide and a badge 14, 19 or 26 px for 1, 2 or 3 characters, with a 2 px ring: two badges of one
// row fit side by side up to 3 characters together, 4 with a lone 1-character badge. Beyond that the drafts badge,
// which grows to the right from the left edge, would cover the right one.
const RowChars = [3, 2, 1, 0];

export type DraftsBadge = { text: string; top: boolean; dot: boolean };

// Where the drafts badge goes and what it says, so it never overlaps the two others: the bottom left, else the top
// left when that row has more room, with the full count when it fits, else "9+", else a bare grey dot (the label
// still gives the number).
export function draftsBadge(counts: ReviewCounts): DraftsBadge {
    const drafts = counts?.drafts ?? 0;
    if (drafts <= 0) {
        return null;
    }
    const room = (other: number) => RowChars[other > 0 ? railCountText(other).length : 0];
    const bottom = room(counts.mergeable ?? 0);
    const top = room(counts.toreview ?? 0);
    const full = railCountText(drafts);
    for (const [chars, isTop] of [
        [bottom, false],
        [top, true],
    ] as const) {
        if (full.length <= chars) {
            return { text: full, top: isTop, dot: false };
        }
    }
    const best = top > bottom ? { chars: top, isTop: true } : { chars: bottom, isTop: false };
    if (best.chars >= 2) {
        return { text: "9+", top: best.isTop, dot: false };
    }
    return { text: "", top: best.isTop, dot: true };
}

export function ReviewsRailBadges({ counts }: { counts: ReviewCounts }) {
    const toreview = counts?.toreview ?? 0;
    const mergeable = counts?.mergeable ?? 0;
    const drafts = draftsBadge(counts);
    return (
        <>
            {toreview > 0 ? (
                <span
                    className={cn(
                        Badge,
                        "molten-reviews-toreview top-0 right-0 bg-[var(--mt-state-waiting)] text-[var(--mt-state-fg)]"
                    )}
                    aria-hidden="true"
                >
                    {railCountText(toreview)}
                </span>
            ) : null}
            {mergeable > 0 ? (
                <span
                    className={cn(
                        Badge,
                        "molten-reviews-mergeable bottom-0 right-0 bg-success text-[var(--mt-state-fg)]"
                    )}
                    aria-hidden="true"
                >
                    {railCountText(mergeable)}
                </span>
            ) : null}
            {drafts != null ? (
                <span
                    className={cn(
                        Badge,
                        "molten-reviews-drafts left-0 bg-muted text-[var(--mt-state-fg)]",
                        drafts.top ? "top-0" : "bottom-0",
                        drafts.dot && "h-2 w-2 min-w-0 p-0"
                    )}
                    aria-hidden="true"
                >
                    {drafts.text}
                </span>
            ) : null}
        </>
    );
}
