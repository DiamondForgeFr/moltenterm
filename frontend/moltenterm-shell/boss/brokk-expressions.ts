// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How Brokk reacts while a bubble is on screen (FR-BOSS-007, AC3 and AC12 to AC14): the one place that owns his
// expression queue and his mood. Every expression the app asks goes through the queue (brokk-queue.ts), which says when
// one starts; the newest one started is told once to every portrait that is on screen, and one that is not showing plays
// nothing and is not kept for later (brokk-live.tsx ignores a gesture asked before it mounted). The mood is kept here
// too, with the bubble, so it follows the forge while the screen is closed and the window hidden (brokk-mood.ts). What
// makes him react is read in brokk-watch.ts; the merges are told by brokk-moments.ts, which loads with the animated
// portrait since the reviews it listens to are heavy. This file is part of the bubble's up-front JavaScript: it imports
// nothing of the portrait.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, Atom, createStore, PrimitiveAtom } from "jotai";
import { AgentStates } from "../agent-state-store";
import { BossBubbleModel } from "./boss-store";
import { AskedExpression, BrokkExpression, rose } from "./brokk-ask-model";
import { BrokkColleagueModel } from "./brokk-colleague-store";
import { EmptyMood, greetingDue, moodAfter, MoodEvent, MoodMemory, moodOf, replayOf } from "./brokk-mood";
import { EmptyQueue, queueAfter, QueueEvent, QueueState } from "./brokk-queue";
import { moodFactsOf, presenceAfter, unseenItems, watchBrokk } from "./brokk-watch";
import { InputEvents } from "./developer-away";

type Store = Pick<ReturnType<typeof createStore>, "get" | "sub">;

// The badge rose (cueAtom changes, boss-store.ts watchCount): the call is asked, and none for a rise that was already
// there when the listening started.
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

export type ListenTarget = {
    addEventListener: (type: string, listener: (event: any) => void, options?: any) => void;
    removeEventListener: (type: string, listener: (event: any) => void, options?: any) => void;
};

export class BrokkExpressionsModel {
    private static instance: BrokkExpressionsModel = null;

    // The newest expression the queue started; null until one was.
    askedAtom = atom(null) as PrimitiveAtom<AskedExpression>;
    // His mood's memory (brokk-mood.ts).
    moodAtom = atom(EmptyMood) as PrimitiveAtom<MoodMemory>;
    // The last keystroke seen on the page: the scene calms his blinks while the developer types.
    lastKeyAtAtom = atom(null) as PrimitiveAtom<number>;

    private queue: QueueState = EmptyQueue;
    private wake: ReturnType<typeof setTimeout> = null;

    private constructor() {}

    static getInstance(): BrokkExpressionsModel {
        if (BrokkExpressionsModel.instance == null) {
            BrokkExpressionsModel.instance = new BrokkExpressionsModel();
        }
        return BrokkExpressionsModel.instance;
    }

    static resetInstance(): void {
        clearTimeout(BrokkExpressionsModel.instance?.wake);
        BrokkExpressionsModel.instance = null;
    }

    private step(event: QueueEvent) {
        clearTimeout(this.wake);
        const step = queueAfter(this.queue, event, Date.now());
        this.queue = step.state;
        if (step.play != null) {
            globalStore.set(this.askedAtom, step.play);
        }
        if (step.wakeAt != null) {
            this.wake = setTimeout(() => this.step({ type: "tick" }), Math.max(step.wakeAt - Date.now(), 0));
        }
        return step;
    }

    // Asks for an expression: the queue decides when it starts, if it does. `reply`: it answers the developer's own
    // action.
    ask(expression: BrokkExpression, options: { reply?: boolean } = {}): void {
        this.step({ type: "ask", expression, reply: options.reply === true });
    }

    note(event: MoodEvent): void {
        const current = globalStore.get(this.moodAtom);
        const next = moodAfter(current, event, Date.now());
        if (next !== current) {
            globalStore.set(this.moodAtom, next);
        }
    }

    // A keystroke on the page: no expression starts for a moment.
    noteKey(): void {
        globalStore.set(this.lastKeyAtAtom, Date.now());
        this.step({ type: "key" });
    }

    // The developer answered or approved something: the caption says so and he nods.
    noteHandled(kind: "answer" | "rerun" | "handoff" | "done"): void {
        this.note({ type: "handled", kind });
        this.ask("nod", { reply: true });
    }

    // A pull request merged (told by brokk-moments.ts).
    noteMerged(number: number): void {
        this.note({ type: "merged", number });
        this.ask("smile");
    }

    // The screen or the card opened and his portrait is showing: he greets a developer who is back, and his mood plays
    // its expression once, at most every five minutes.
    noteOpen(): void {
        const now = Date.now();
        const memory = globalStore.get(this.moodAtom);
        if (greetingDue(memory, now)) {
            this.note({ type: "greeted" });
            this.ask("nod");
        }
        const items = unseenItems(globalStore.get(BossBubbleModel.getInstance().toHandleAtom));
        const expression = replayOf(memory, moodOf(memory, moodFactsOf(items), now), now);
        if (expression == null) {
            return;
        }
        const step = this.step({ type: "ask", expression, reply: false });
        if (step.state.slot?.expression === expression || step.play?.expression === expression) {
            this.note({ type: "replayed" });
        }
    }

    // Listens while a bubble is on screen: the badge's rises, the forge's events, the keystrokes and the developer's
    // comings and goings.
    watch(target: ListenTarget = document): () => void {
        const bubble = BossBubbleModel.getInstance();
        const agents = AgentStates.getInstance();
        const stopCalls = watchCalls(globalStore, bubble.cueAtom, (expression) => {
            this.note({ type: "arrived" });
            if (!globalStore.get(bubble.cardOpenAtom)) {
                this.ask(expression);
            }
        });
        const stopForge = watchBrokk(
            {
                store: globalStore,
                agentsAtom: agents.dataAtom,
                agentsLoadedAtom: agents.loadedAtom,
                toHandleAtom: bubble.toHandleAtom,
                now: () => Date.now(),
                setTimer: (run, ms) => setTimeout(run, ms),
                clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
            },
            {
                ask: (expression, options) => this.ask(expression, options),
                note: (event) => this.note(event),
                memory: () => globalStore.get(this.moodAtom),
            }
        );
        // The kind colleague's moments (brokk-colleague.ts) count stretches of activity from these very inputs: Brokk has
        // one tracker of the developer's presence, not two.
        const colleague = BrokkColleagueModel.getInstance();
        const stopColleague = colleague.start();
        let last = Date.now();
        const onInput = () => {
            const seen = presenceAfter(last, Date.now());
            last = seen.last;
            if (seen.returnedSince != null) {
                this.note({ type: "returned", since: seen.returnedSince });
            }
            colleague.noteInput();
        };
        const onKey = () => this.noteKey();
        const options = { capture: true, passive: true };
        InputEvents.forEach((name) => target.addEventListener(name, onInput, options));
        target.addEventListener("keydown", onKey, options);
        return () => {
            stopCalls();
            stopForge();
            stopColleague();
            InputEvents.forEach((name) => target.removeEventListener(name, onInput, options));
            target.removeEventListener("keydown", onKey, options);
        };
    }
}
