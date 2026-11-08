// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The one moment that only the animated portrait listens to (FR-BOSS-007, AC3 and AC14): a pull request merges, and he
// smiles. Everything else that makes him react (a failure, a long wait, an agent that finishes, a list cleared) is read
// with the bubble (brokk-watch.ts), since it has to be known while the screen is closed. The merges come from the
// reviews of the Integration panel, a heavy model the bubble does not load up front: this file starts with the
// portrait, on the first opening of the screen or the first call, and stops when the last one goes. What merged before
// is not news to a face that was not showing.

import { globalStore } from "@/app/store/jotaiStore";
import { Atom, createStore } from "jotai";
import { ReviewsModel } from "../reviews/reviews-store";
import { BrokkExpressionsModel } from "./brokk-expressions";

type Store = Pick<ReturnType<typeof createStore>, "get" | "sub">;

export type MomentSources = {
    store: Store;
    mergedAtom: Atom<Record<string, { merged?: number[] }>>;
};

export function mergedNumbers(afterMerge: Record<string, { merged?: number[] }>): Set<string> {
    const numbers = new Set<string>();
    for (const [dir, after] of Object.entries(afterMerge ?? {})) {
        (after?.merged ?? []).forEach((number) => numbers.add(`${dir}#${number}`));
    }
    return numbers;
}

// Tells each pull request that merged since the listening started, and none that was there already.
export function watchMerges(src: MomentSources, merged: (number: number) => void): () => void {
    let seen: Set<string> = null;
    const check = () => {
        const next = mergedNumbers(src.store.get(src.mergedAtom));
        if (seen != null) {
            for (const key of next) {
                if (!seen.has(key)) {
                    merged(Number(key.slice(key.lastIndexOf("#") + 1)));
                }
            }
        }
        seen = next;
    };
    const stop = src.store.sub(src.mergedAtom, check);
    check();
    return stop;
}

let users = 0;
let stopWatching: () => void = null;

// One listening for every portrait on screen (the bubble's screen and the card's header can show together): two would
// tell each merge twice. The first to mount starts it, the last to go stops it.
export function startMoments(): () => void {
    users++;
    if (users === 1) {
        stopWatching = watchMerges(
            { store: globalStore, mergedAtom: ReviewsModel.getInstance().afterMergeAtom },
            (number) => BrokkExpressionsModel.getInstance().noteMerged(number)
        );
    }
    let stopped = false;
    return () => {
        if (stopped) {
            return;
        }
        stopped = true;
        users--;
        if (users === 0) {
            stopWatching?.();
            stopWatching = null;
        }
    };
}
