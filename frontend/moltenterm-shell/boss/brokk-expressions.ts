// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The gestures the app asks of Brokk (FR-BOSS-007, AC3): the newest one asked, and the listening that asks them. A
// gesture is a fact that happened (the count of the badge rose, an agent failed, a pull request merged, the developer
// answered), told once to every portrait that is on screen; one that is not showing plays nothing and is not kept for
// later (brokk-live.tsx ignores a gesture asked before it mounted). The rules that decide are in
// brokk-expression-model.ts; this file only listens and asks.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, Atom, createStore, PrimitiveAtom } from "jotai";
import type { AgentStatesData } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { ReviewsModel } from "../reviews/reviews-store";
import { BossBubbleModel } from "./boss-store";
import { errorKeys, longWaits, mergedCount, newFailure, rose, stillWaiting } from "./brokk-expression-model";
import { askedAfter, type AskedExpression, type BrokkExpression } from "./brokk-state-model";

type Store = Pick<ReturnType<typeof createStore>, "get" | "sub">;

// What is listened to, so that the rules run against stand-ins in the tests.
export type ExpressionSources = {
    store: Store;
    agentsAtom: Atom<AgentStatesData>;
    agentsLoadedAtom: Atom<boolean>;
    mergedAtom: Atom<Record<string, { merged?: number[] }>>;
    // Changes when the count of the badge rose (boss-store.ts, watchCount).
    cueAtom: Atom<number>;
    now: () => number;
    setTimer: (run: () => void, ms: number) => unknown;
    clearTimer: (timer: unknown) => void;
};

export function watchExpressions(src: ExpressionSources, ask: (expression: BrokkExpression) => void): () => void {
    let failures: Set<string> = null;
    let told = new Set<string>();
    let timer: unknown = null;
    let merged: number = null;
    let cue: number = null;

    const checkAgents = () => {
        src.clearTimer(timer);
        timer = null;
        if (!src.store.get(src.agentsLoadedAtom)) {
            return;
        }
        const data = src.store.get(src.agentsAtom);
        const failed = errorKeys(data);
        if (newFailure(failures, failed)) {
            ask("frown");
        }
        failures = failed;
        told = stillWaiting(data, told);
        const waits = longWaits(data, src.now(), told);
        if (waits.due.length > 0) {
            waits.due.forEach((key) => told.add(key));
            ask("doubtful");
        }
        if (waits.nextAt != null) {
            timer = src.setTimer(checkAgents, Math.max(waits.nextAt - src.now(), 0) + 1);
        }
    };
    const checkMerged = () => {
        const count = mergedCount(src.store.get(src.mergedAtom));
        if (rose(merged, count)) {
            ask("smile");
        }
        merged = count;
    };
    const checkCue = () => {
        const next = src.store.get(src.cueAtom);
        if (rose(cue, next)) {
            ask("call");
        }
        cue = next;
    };

    const stops = [
        src.store.sub(src.agentsAtom, checkAgents),
        src.store.sub(src.agentsLoadedAtom, checkAgents),
        src.store.sub(src.mergedAtom, checkMerged),
        src.store.sub(src.cueAtom, checkCue),
    ];
    checkAgents();
    checkMerged();
    checkCue();
    return () => {
        stops.forEach((stop) => stop());
        src.clearTimer(timer);
    };
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
        const agents = AgentStates.getInstance();
        return watchExpressions(
            {
                store: globalStore,
                agentsAtom: agents.dataAtom,
                agentsLoadedAtom: agents.loadedAtom,
                mergedAtom: ReviewsModel.getInstance().afterMergeAtom,
                cueAtom: BossBubbleModel.getInstance().cueAtom,
                now: () => Date.now(),
                setTimer: (run, ms) => setTimeout(run, ms),
                clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
            },
            (expression) => this.ask(expression)
        );
    }
}
