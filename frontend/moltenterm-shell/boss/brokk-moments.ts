// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The moments that make Brokk's face react while his portrait is on screen (FR-BOSS-007, AC3): an agent fails (a frown),
// an agent has waited too long (a doubtful look), a pull request merges (a smile). It listens to the agent states and
// the merges, and asks through the model of the gestures (brokk-expressions.ts). It starts when his portrait mounts and
// stops when the last one goes, so it loads with the portrait, on the first opening of the screen, and costs the bubble
// nothing before; what happened before is not news to a face that was not showing. The rules that decide are in
// brokk-expression-model.ts; this file only listens and asks.

import { globalStore } from "@/app/store/jotaiStore";
import { Atom, createStore } from "jotai";
import type { AgentStatesData } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { ReviewsModel } from "../reviews/reviews-store";
import { rose, type BrokkExpression } from "./brokk-ask-model";
import { errorKeys, longWaits, mergedCount, newFailure, stillWaiting } from "./brokk-expression-model";
import { BrokkExpressionsModel } from "./brokk-expressions";

type Store = Pick<ReturnType<typeof createStore>, "get" | "sub">;

// What is listened to, so that the rules run against stand-ins in the tests.
export type MomentSources = {
    store: Store;
    agentsAtom: Atom<AgentStatesData>;
    agentsLoadedAtom: Atom<boolean>;
    mergedAtom: Atom<Record<string, { merged?: number[] }>>;
    now: () => number;
    setTimer: (run: () => void, ms: number) => unknown;
    clearTimer: (timer: unknown) => void;
};

export function watchMoments(src: MomentSources, ask: (expression: BrokkExpression) => void): () => void {
    let failures: Set<string> = null;
    let told = new Set<string>();
    let timer: unknown = null;
    let merged: number = null;

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

    const stops = [
        src.store.sub(src.agentsAtom, checkAgents),
        src.store.sub(src.agentsLoadedAtom, checkAgents),
        src.store.sub(src.mergedAtom, checkMerged),
    ];
    checkAgents();
    checkMerged();
    return () => {
        stops.forEach((stop) => stop());
        src.clearTimer(timer);
    };
}

let users = 0;
let stopWatching: () => void = null;

// One listening for every portrait on screen (the bubble's screen and the card's header can show together): two would
// ask each gesture twice. The first to mount starts it, the last to go stops it.
export function startMoments(): () => void {
    users++;
    if (users === 1) {
        const agents = AgentStates.getInstance();
        stopWatching = watchMoments(
            {
                store: globalStore,
                agentsAtom: agents.dataAtom,
                agentsLoadedAtom: agents.loadedAtom,
                mergedAtom: ReviewsModel.getInstance().afterMergeAtom,
                now: () => Date.now(),
                setTimer: (run, ms) => setTimeout(run, ms),
                clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
            },
            (expression) => BrokkExpressionsModel.getInstance().ask(expression)
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
