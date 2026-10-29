// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pull request status dots on the block that shows Integration (FR-SHELL-085, #1304; FR-SHELL-098, #1327): one
// small dot per section of the panel with pull requests, stacked in the block's corner column under its agent mark
// or modified ring, the most critical at the top. No number on the block: each dot's tooltip and accessible name
// give the section's title and the number of PRs it lists (blocked is a diamond, not a round dot). Dots showing up fade
// in once, a dot whose count changes glows once: nothing moves at rest.

import { atoms } from "@/app/store/global";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { cn } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useT, useTCount } from "../i18n/i18n";
import { useCardContext } from "../reviews/reviews-agent-bar";
import { useListedReviewsAnswer } from "../reviews/reviews-client";
import { rebaseAskKey, splitReviews } from "../reviews/reviews-model";
import { cardStates } from "../reviews/reviews-sections-model";
import { ReviewsModel } from "../reviews/reviews-store";
import { useUpcomingWatch } from "../reviews/reviews-upcoming-client";
import { readWorkspaceProject } from "../workspace-project";
import {
    firstPilotageTab,
    hasPrCounts,
    PrCountKey,
    PrCountKind,
    PrCountKinds,
    PrCounts,
    prCountSectionKey,
    prCounts,
    shownPrKinds,
    ViewBlocks,
} from "./pr-counts-model";

// The blocks that showed dots, by area and workspace: coming back to a workspace shows them calm, not fading in again.
const ShownCounts = new Set<string>();

// A block of an area: its tab in this workspace (empty when the view has no instance here), and the views its
// configuration names, read when there is no tab.
export type AreaBlock = { key: string; tabId: string; configViews?: string[] };

// The current workspace's counts, from the Integration panel's answer for the workspace's project and its cards'
// states (the agents on each branch), so a PR counts in the state its card shows. The sidebar's library keeps the
// answers fresh (useReviewsRailWatch, useWorkspacePrStatesWatch): no poll of its own.
export function useWorkspacePrCounts(): PrCounts {
    const workspace = useAtomValue(atoms.workspace);
    const dir = readWorkspaceProject(workspace).dir;
    const answer = useListedReviewsAnswer(dir);
    const model = ReviewsModel.getInstance();
    const readied = useAtomValue(model.readiedAtom);
    const asks = useAtomValue(model.rebaseAsksAtom);
    const ctx = useCardContext(dir);
    return useMemo(() => {
        if (answer?.state !== "ok") {
            return prCounts(answer, readied);
        }
        const split = splitReviews(answer, readied);
        const cards = cardStates([...split.ready, ...split.drafts], asks, (n) => rebaseAskKey(dir, n), ctx);
        return prCounts(answer, readied, cards);
    }, [answer, readied, asks, ctx, dir]);
}

// Where the agents of the project's branches are, for the dots' blocked state (an agent waiting on a question, a
// conflict an agent already works on) while the panel itself is closed: asked once per GitHub read, as the panel does.
export function useWorkspacePrStatesWatch(dir: string) {
    const answer = useListedReviewsAnswer(dir);
    const listed = answer?.state === "ok" && (answer.ready?.length ?? 0) + (answer.drafts?.length ?? 0) > 0;
    useUpcomingWatch(dir, listed ? answer : null);
}

// The key of the area's first block whose view holds an Integration panel; "" when none does.
export function usePilotageBlock(blocks: AreaBlock[]): string {
    const signature = JSON.stringify(blocks);
    const pilotageAtom = useMemo(
        () =>
            atom((get) => {
                const facts: ViewBlocks[] = blocks.map((block) => {
                    if (!block.tabId) {
                        return { tabId: block.key, views: block.configViews ?? [] };
                    }
                    const tab = get(getWaveObjectAtom<Tab>(makeORef("tab", block.tabId)));
                    const views = (tab?.blockids ?? []).map(
                        (id) => (get(getWaveObjectAtom<Block>(makeORef("block", id)))?.meta?.view as string) ?? ""
                    );
                    return { tabId: block.key, views };
                });
                return firstPilotageTab(facts);
            }),
        // The blocks' content, not the array: a new array each render would rebuild the atom every time.
        [signature]
    );
    return useAtomValue(pilotageAtom);
}

// fresh: the dots just showed up where there were none, they fade in once. Otherwise they show calm, e.g. when the
// sidebar comes back to a workspace that already showed them.
export function useCountsMotion(key: string, has: boolean): { fresh: boolean } {
    const [motion, setMotion] = useState(() => ({ key, has, fresh: has && !ShownCounts.has(key) }));
    let current = motion;
    if (motion.key !== key || motion.has !== has) {
        const fresh = has && (motion.key !== key ? !ShownCounts.has(key) : !motion.has);
        current = { key, has, fresh };
        setMotion(current);
    }
    useEffect(() => {
        if (has) {
            ShownCounts.add(key);
        } else {
            ShownCounts.delete(key);
        }
    }, [key, has]);
    return { fresh: current.fresh };
}

// The count each dot last glowed at: a dot whose count changed remounts once with the glow, so a later change glows
// again and a render in between never cuts the glow short.
function useBumps(counts: PrCounts, motionKey: string): Partial<PrCounts> {
    const [seen, setSeen] = useState({ key: motionKey, counts });
    const [bumped, setBumped] = useState<Partial<PrCounts>>({});
    if (seen.key !== motionKey) {
        setSeen({ key: motionKey, counts });
        setBumped({});
        return {};
    }
    // Dots showing up where there were none fade in: no glow on top.
    const changed = hasPrCounts(seen.counts)
        ? PrCountKinds.filter((kind) => seen.counts[kind] !== counts[kind] && counts[kind] > 0)
        : [];
    if (PrCountKinds.some((kind) => seen.counts[kind] !== counts[kind])) {
        const next = { ...bumped };
        for (const kind of changed) {
            next[kind] = counts[kind];
        }
        setSeen({ key: motionKey, counts });
        setBumped(next);
        return next;
    }
    return bumped;
}

// The block's tooltip line and the column's accessible name: every state with pull requests, with its count.
export function usePrCountsSummary(counts: PrCounts): string {
    const label = usePrCountLabel();
    return shownPrKinds(counts)
        .map((kind) => label(kind, counts[kind]))
        .join(", ");
}

// A dot's words: the name of the panel's section it counts and the number of PRs that section lists (FR-SHELL-098).
function usePrCountLabel(): (kind: PrCountKind, count: number) => string {
    const t = useT();
    const tc = useTCount();
    return (kind, count) => tc(PrCountKey, count, { section: t(prCountSectionKey(kind)) });
}

export function PrDots({
    counts,
    motionKey,
    calm,
    small,
}: {
    counts: PrCounts;
    motionKey: string;
    calm: boolean;
    small?: boolean;
}) {
    const label = usePrCountLabel();
    const bumped = useBumps(counts, motionKey);
    const summary = usePrCountsSummary(counts);
    if (!hasPrCounts(counts)) {
        return null;
    }
    return (
        <span
            className={cn("mt-sb-prdots", small && "is-small", calm && "is-calm")}
            role="group"
            aria-label={summary}
            data-testid="sidebar-pr-counts"
        >
            {shownPrKinds(counts).map((kind: PrCountKind) => {
                const bump = bumped[kind] === counts[kind];
                const words = label(kind, counts[kind]);
                return (
                    <span
                        key={bump ? `${kind}-${counts[kind]}` : kind}
                        className={cn("mt-sb-prdot", `is-${kind}`, bump && "is-bump")}
                        role="img"
                        title={words}
                        aria-label={words}
                        data-kind={kind}
                        data-count={counts[kind]}
                    />
                );
            })}
        </span>
    );
}
