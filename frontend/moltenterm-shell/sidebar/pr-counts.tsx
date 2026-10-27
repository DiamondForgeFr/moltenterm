// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pull request counts under the block that shows Pilotage (FR-SHELL-085, prototype of #1181): soft tinted pills
// centred just under the block, outside it. The block takes room below it, so only its row grows; counts showing up
// where there were none open the row first, then fade in; a change of numbers only bumps the pill that changed. Every
// animation runs once: nothing moves at rest.

import { atoms } from "@/app/store/global";
import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { cn } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useTCount } from "../i18n/i18n";
import { useListedReviewsAnswer } from "../reviews/reviews-client";
import { ReviewsModel } from "../reviews/reviews-store";
import { readWorkspaceProject } from "../workspace-project";
import {
    firstPilotageTab,
    hasPrCounts,
    PrCountKeys,
    PrCountKind,
    PrCountKinds,
    PrCounts,
    prCounts,
    prCountText,
    ViewBlocks,
} from "./pr-counts-model";

// The blocks that showed counts, by area and workspace: coming back to a workspace shows them calm, not opening again.
const ShownCounts = new Set<string>();

// A block of an area: its tab in this workspace (empty when the view has no instance here), and the views its
// configuration names, read when there is no tab.
export type AreaBlock = { key: string; tabId: string; configViews?: string[] };

// The current workspace's counts, from Pilotage's answer for the workspace's project. The sidebar's library already
// keeps that answer fresh (useReviewsRailWatch): no poll of its own.
export function useWorkspacePrCounts(): PrCounts {
    const workspace = useAtomValue(atoms.workspace);
    const dir = readWorkspaceProject(workspace).dir;
    const answer = useListedReviewsAnswer(dir);
    const readied = useAtomValue(ReviewsModel.getInstance().readiedAtom);
    return useMemo(() => prCounts(answer, readied), [answer, readied]);
}

// The key of the area's first block whose view holds a Pilotage panel; "" when none does.
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

// grow: the counts just showed up where there were none, the block opens its row before they fade in. Otherwise they
// show calm (no fade), e.g. when the sidebar comes back to a workspace that already showed them.
export function useCountsMotion(key: string, has: boolean): { grow: boolean } {
    const [motion, setMotion] = useState(() => ({ key, has, grow: has && !ShownCounts.has(key) }));
    let current = motion;
    if (motion.key !== key || motion.has !== has) {
        const grow = has && (motion.key !== key ? !ShownCounts.has(key) : !motion.has);
        current = { key, has, grow };
        setMotion(current);
    }
    useEffect(() => {
        if (has) {
            ShownCounts.add(key);
        } else {
            ShownCounts.delete(key);
        }
    }, [key, has]);
    return { grow: current.grow };
}

// The count each pill last bumped at: a pill whose number changed remounts once with the bump, so a later change
// bumps again and a render in between never cuts the bump short.
function useBumps(counts: PrCounts, motionKey: string): Partial<PrCounts> {
    const [seen, setSeen] = useState({ key: motionKey, counts });
    const [bumped, setBumped] = useState<Partial<PrCounts>>({});
    if (seen.key !== motionKey) {
        setSeen({ key: motionKey, counts });
        setBumped({});
        return {};
    }
    // Counts showing up where there were none fade in with their row: no bump on top.
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

export function PrPips({
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
    const tc = useTCount();
    const bumped = useBumps(counts, motionKey);
    if (!hasPrCounts(counts)) {
        return null;
    }
    return (
        <span className={cn("mt-sb-pips", small && "is-small", calm && "is-calm")} data-testid="sidebar-pr-counts">
            {PrCountKinds.filter((kind) => counts[kind] > 0).map((kind: PrCountKind) => {
                const bump = bumped[kind] === counts[kind];
                const label = tc(PrCountKeys[kind], counts[kind]);
                return (
                    <span
                        key={bump ? `${kind}-${counts[kind]}` : kind}
                        className={cn("mt-sb-pip", `is-${kind}`, bump && "is-bump")}
                        title={label}
                        aria-label={label}
                        data-kind={kind}
                    >
                        {prCountText(counts[kind])}
                    </span>
                );
            })}
        </span>
    );
}
