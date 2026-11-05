// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The gestures the app asks of Brokk (FR-BOSS-007, AC3): the newest one asked, and the one listening that is always on,
// the call when the count of the badge rises. A gesture is a fact that happened, told once to every portrait that is on
// screen; one that is not showing plays nothing and is not kept for later (brokk-live.tsx ignores a gesture asked
// before it mounted). The other moments (a failure, a long wait, a merge) are listened to by brokk-moments.ts, which
// loads with the animated portrait. This file is part of the bubble's up-front JavaScript: it imports nothing of the
// portrait.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, Atom, createStore, PrimitiveAtom } from "jotai";
import { BossBubbleModel } from "./boss-store";
import { askedAfter, rose, type AskedExpression, type BrokkExpression } from "./brokk-ask-model";

type Store = Pick<ReturnType<typeof createStore>, "get" | "sub">;

// The count of the badge rose (cueAtom changes, boss-store.ts watchCount): a call, and none for a rise that was
// already there when the listening started.
export function watchCalls(
    store: Store,
    cueAtom: Atom<number>,
    ask: (expression: BrokkExpression) => void
): () => void {
    let last = store.get(cueAtom);
    return store.sub(cueAtom, () => {
        const next = store.get(cueAtom);
        if (rose(last, next)) {
            ask("call");
        }
        last = next;
    });
}

export class BrokkExpressionsModel {
    private static instance: BrokkExpressionsModel = null;

    // The newest gesture asked; null until one was.
    askedAtom = atom(null) as PrimitiveAtom<AskedExpression>;

    private constructor() {}

    static getInstance(): BrokkExpressionsModel {
        if (BrokkExpressionsModel.instance == null) {
            BrokkExpressionsModel.instance = new BrokkExpressionsModel();
        }
        return BrokkExpressionsModel.instance;
    }

    static resetInstance(): void {
        BrokkExpressionsModel.instance = null;
    }

    ask(expression: BrokkExpression): void {
        const current = globalStore.get(this.askedAtom);
        const next = askedAfter(current, expression, Date.now());
        if (next !== current) {
            globalStore.set(this.askedAtom, next);
        }
    }

    // Listens while a bubble is on screen.
    watch(): () => void {
        return watchCalls(globalStore, BossBubbleModel.getInstance().cueAtom, (expression) => this.ask(expression));
    }
}
