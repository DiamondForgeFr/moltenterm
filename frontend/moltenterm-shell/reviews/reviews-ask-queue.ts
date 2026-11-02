// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Queued asks for a busy agent (#1062, FR-REV-022 AC12): a task asked from a card that reached an agent busy on the
// branch waits here, on the developer's "Hand the rebase to {name} after its task", and is sent to that agent once it
// is neither working nor waiting. It lives for the app session. The sending itself is ReviewsModel's (sender), so this
// class is tested alone with fake agent states.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import type { AgentStatesData } from "../agent-state-model";
import { phrase, type Phrase } from "../i18n/phrase";
import { rebaseAskKey, type RebaseOutcome, type ReviewPr } from "./reviews-model";
import type { PrTaskKind } from "./reviews-task-model";

// The agent a busy answer named: its terminal and its first name.
export type BusyAgent = { blockId: string; name: string };

// sending: handed over, the answer not back yet; failed: what stopped it (the card says it, Dismiss clears it).
export type QueuedAsk = {
    dir: string;
    repo: string;
    pr: ReviewPr;
    kind: PrTaskKind;
    agent: BusyAgent;
    mergedPr?: number;
    // A finish that also marks the draft ready (#1212).
    markReady?: boolean;
    at: number;
    sending?: boolean;
    failed?: Phrase;
};

export type AskSender = (ask: QueuedAsk) => Promise<RebaseOutcome>;

// An agent busy on its task: the ask waits while its terminal reports one of these.
const BusyStates = new Set(["working", "waiting"]);

export class ReviewsAskQueue {
    private static instance: ReviewsAskQueue = null;

    asksAtom = atom({}) as PrimitiveAtom<Record<string, QueuedAsk>>;
    sender: AskSender = null;
    statesOf: () => AgentStatesData = null;
    unsubscribe: () => void = null;

    private constructor() {}

    static getInstance(): ReviewsAskQueue {
        if (ReviewsAskQueue.instance == null) {
            ReviewsAskQueue.instance = new ReviewsAskQueue();
        }
        return ReviewsAskQueue.instance;
    }

    static resetInstance(): void {
        ReviewsAskQueue.instance?.unsubscribe?.();
        ReviewsAskQueue.instance = null;
    }

    get(dir: string, number: number): QueuedAsk {
        return globalStore.get(this.asksAtom)[rebaseAskKey(dir, number)];
    }

    private put(key: string, ask: QueuedAsk) {
        const asks = globalStore.get(this.asksAtom);
        const next = { ...asks };
        if (ask == null) {
            delete next[key];
        } else {
            next[key] = ask;
        }
        globalStore.set(this.asksAtom, next);
    }

    // queue: the developer's click on "Hand the rebase to {name} after its task". The agent may be free already.
    queue(ask: Omit<QueuedAsk, "at" | "sending" | "failed">) {
        if (ask?.pr == null || !ask.dir || !ask.agent?.blockId) {
            return;
        }
        this.put(rebaseAskKey(ask.dir, ask.pr.number), { ...ask, at: Date.now() });
        this.check(this.statesOf?.());
    }

    cancel(dir: string, number: number) {
        this.put(rebaseAskKey(dir, number), null);
    }

    // refresh: the list's latest read of a project's PRs: a queued ask goes with the PR's current head and state, and
    // is dropped with a word on the card once its PR left the list (merged, closed).
    refresh(dir: string, prs: readonly ReviewPr[]) {
        const asks = globalStore.get(this.asksAtom);
        let next: Record<string, QueuedAsk> = null;
        for (const [key, ask] of Object.entries(asks)) {
            if (ask.dir !== dir || ask.failed != null) {
                continue;
            }
            const pr = prs.find((p) => p.number === ask.pr.number);
            if (pr === ask.pr) {
                continue;
            }
            next ??= { ...asks };
            next[key] =
                pr == null
                    ? { ...ask, failed: phrase("reviews.queue.ask.prGone", { number: ask.pr.number }) }
                    : { ...ask, pr };
        }
        if (next != null) {
            globalStore.set(this.asksAtom, next);
        }
    }

    // check: each waiting ask whose agent is neither working nor waiting any more is sent. An agent whose state is
    // gone is sent to as well: wavesrv's answer says whether one still runs there.
    check(states: AgentStatesData) {
        if (this.sender == null) {
            return;
        }
        for (const [key, ask] of Object.entries(globalStore.get(this.asksAtom))) {
            if (ask.sending || ask.failed != null) {
                continue;
            }
            const state = states?.states?.[ask.agent.blockId]?.state;
            if (state != null && BusyStates.has(state)) {
                continue;
            }
            this.send(key, ask);
        }
    }

    private send(key: string, ask: QueuedAsk) {
        this.put(key, { ...ask, sending: true });
        this.sender(ask).then(
            (outcome) => this.settle(key, ask, outcome),
            () => this.settle(key, ask, null)
        );
    }

    // settle: an ask taken leaves the queue (the card follows the task); an agent busy again, or another one of the
    // worktree, keeps it queued on that agent; anything else stops it with its reason on the card.
    private settle(key: string, ask: QueuedAsk, outcome: RebaseOutcome) {
        if (globalStore.get(this.asksAtom)[key] == null) {
            return;
        }
        if (outcome?.kind === "asked") {
            this.put(key, null);
            return;
        }
        if (outcome?.busy != null) {
            this.put(key, { ...ask, agent: outcome.busy, sending: false });
            return;
        }
        let failed: Phrase;
        if (outcome == null) {
            failed = phrase("reviews.queue.ask.failed", { name: ask.agent.name });
        } else if (outcome.kind === "offer") {
            failed = phrase("reviews.queue.ask.noAgent", { name: ask.agent.name });
        } else {
            failed = outcome.text;
        }
        this.put(key, { ...ask, sending: false, failed });
    }
}
