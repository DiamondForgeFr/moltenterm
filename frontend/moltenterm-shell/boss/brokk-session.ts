// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's side of Brokk's own terminal session (FR-BOSS-009, AC15 and AC23, #2003, #2033): the conversation window
// gives its messages to wavesrv (pkg/molten/brokksession), which starts the session on the first one and types the next
// ones into it. The block of that session is kept on the hub's model, so that the ring around his avatar turns while its
// agent works. Nothing starts without a message the developer sends.
//
// His session works in a hidden tab: once his agent has a message, its answer is read back from his transcript (#2028)
// and kept in the exchange, one answer per message. A message sent while he is still answering never loses the first
// answer: when his agent cannot take it, the first answer keeps coming in; when it takes it, the first answer is read to
// its end, by its turn, before the second is followed. An answer that cannot be read points to his terminal.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom } from "jotai";
import { BossBubbleModel } from "./boss-store";
import { ExchangeItem, SpeakingHoldMs, withAnswer, withMessage } from "./brokk-exchange-model";
import { BrokkHubModel } from "./brokk-hub-store";
import {
    FollowEveryMs,
    followStep,
    IdleTalk,
    MaxFollowMs,
    ReplyResult,
    SayResult,
    SendingTalk,
    StartFollow,
    StartingTalk,
    TalkState,
    talkStateOf,
} from "./brokk-talk-model";

// must match pkg/molten/brokksession/live.go
export const SessionRouteId = "molten:brokk";
export const SessionCommand = "moltenbrokksession";
export const SayCommand = "moltenbrokksay";
export const ReplyCommand = "moltenbrokkreply";

const FindTimeoutMs = 8000;
// wavesrv waits up to 90 s for an agent just started to show its prompt.
const SayTimeoutMs = 120000;
// The answer's time is the agent's clock, the message's this window's: the same computer, give or take a record.
const SentSlackMs = 2000;

type Call = (command: string, data: Record<string, unknown>, timeoutMs: number) => Promise<any>;
type Wait = (ms: number) => Promise<void>;

const LiveCall: Call = (command, data, timeout) =>
    TabRpcClient.wshRpcCall(command, data, { route: SessionRouteId, timeout });

const LiveWait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// His answer as it is read, for what follows his conversation (the brainstorm of FR-BOSS-010, #2246): the message it
// answers, what he has written so far, its turn in his transcript, and whether his agent is done with it.
export type AnswerRead = { id: string; you: string; markdown: string; turn: number; final: boolean };

export type AnswerListener = (answer: AnswerRead) => void;

// A message whose answer is followed.
type Tracked = {
    // The message's id in the exchange, which its answer carries too.
    id: string;
    // What the developer sent.
    text: string;
    sentAt: number;
    // The turn of his transcript the answer was read from; 0 until the first reading.
    turn: number;
    // The answer as read last.
    markdown: string;
    // Its following ended, or was taken over by a settling read.
    stopped: boolean;
};

export class BrokkSession {
    private static instance: BrokkSession = null;

    // The status of the last message, for the notes of the window.
    stateAtom = atom(IdleTalk) as PrimitiveAtom<TalkState>;
    // The developer's messages and his answers, oldest first, for as long as MoltenTerm runs.
    exchangeAtom = atom([]) as PrimitiveAtom<ExchangeItem[]>;
    // His answer is coming in, or came a moment ago: his face speaks (FR-BOSS-009, AC25).
    speakingAtom = atom(false) as PrimitiveAtom<boolean>;
    // The answer that changed while the window was folded: his line under the square (AC25). Null when seen.
    unseenIdAtom = atom(null) as PrimitiveAtom<string>;

    private call: Call = LiveCall;
    private wait: Wait = LiveWait;
    // A new message ends the wait of a message that did not leave yet.
    private sendGen = 0;
    private counter = 0;
    private tracked: Tracked = null;
    // The message whose answer writes the status: after a failure nothing does, so its note stays until the developer
    // writes again.
    private stateOwner: string = null;
    private windowOpen = false;
    private speakGen = 0;
    private answerListeners = new Set<AnswerListener>();
    private replayed = new Map<string, Tracked>();
    // Words put before the developer's next message, shown in the exchange as sent (the brainstorm's start, #2246).
    private lead = "";

    static getInstance(): BrokkSession {
        if (BrokkSession.instance == null) {
            BrokkSession.instance = new BrokkSession();
        }
        return BrokkSession.instance;
    }

    static resetInstance(): void {
        BrokkSession.instance = null;
    }

    // Tests give a call and a wait of their own.
    useCall(call: Call): void {
        this.call = call;
    }

    useWait(wait: Wait): void {
        this.wait = wait;
    }

    // Each reading of his answer, while it comes in and once it is complete. Returns the stop.
    listenAnswers(listener: AnswerListener): () => void {
        this.answerListeners.add(listener);
        return () => this.answerListeners.delete(listener);
    }

    private told(tracked: Tracked, final: boolean): void {
        const answer: AnswerRead = {
            id: tracked.id,
            you: tracked.text,
            markdown: tracked.markdown,
            turn: tracked.turn,
            final,
        };
        this.answerListeners.forEach((listener) => {
            try {
                listener(answer);
            } catch (e) {
                console.log("brokk session: a listener of his answers failed", e);
            }
        });
    }

    // A line of his that MoltenTerm says for him, with no message behind it (the brainstorm's opening, #2246): it shows
    // in the exchange as his, complete, and offers nothing.
    addLocalLine(text: string): void {
        const id = `local${++this.counter}`;
        globalStore.set(this.exchangeAtom, (items) =>
            withAnswer(items, id, { markdown: text, turn: 0, at: Date.now(), final: true })
        );
    }

    // Words the developer's next message starts with; "" for none. The message shows with them, as it is sent.
    setLead(lead: string): void {
        this.lead = lead ?? "";
    }

    // The scripted replay of a brainstorm (dev and local builds, #2246): a message and what he answers to it so far, as
    // if his agent had written it, read the way a real answer is. Nothing reaches his session. `key` names the exchange.
    replayStep(key: string, you: string, markdown: string, turn: number, final: boolean): void {
        let tracked = this.replayed.get(key);
        if (tracked == null) {
            tracked = { id: `replay${++this.counter}`, text: you, sentAt: Date.now(), turn, markdown: "", stopped: true };
            this.replayed.set(key, tracked);
            const id = tracked.id;
            globalStore.set(this.exchangeAtom, (items) => withMessage(items, id, you, Date.now()));
        }
        this.keepAnswer(tracked, { status: "answer", markdown, index: turn, at: Date.now() }, final);
    }

    private keep(result: { blockid?: string }): void {
        if (result?.blockid) {
            globalStore.set(BrokkHubModel.getInstance().sessionBlockAtom, result.blockid);
        }
    }

    // Finds the session a restart left, so that the ring turns for it. Starts nothing.
    async find(): Promise<void> {
        await this.lookup();
    }

    private async lookup(): Promise<SayResult> {
        try {
            const result: SayResult = await this.call(SessionCommand, {}, FindTimeoutMs);
            if (result?.status === "ready") {
                this.keep(result);
            }
            return result;
        } catch (e) {
            console.log("brokk session: not found", e);
            return null;
        }
    }

    // The conversation window opens or folds: what he said while it was folded is his line under the square until the
    // developer looks.
    setWindowOpen(open: boolean): void {
        this.windowOpen = open;
        if (open) {
            globalStore.set(this.unseenIdAtom, null);
        }
    }

    // Gives the message to his session, starting it when it does not exist, then follows his answer. Resolves with
    // what came of the message.
    async say(typed: string): Promise<TalkState> {
        const model = BossBubbleModel.getInstance();
        const lead = this.lead;
        const text = lead !== "" ? `${lead} ${typed}` : typed;
        const gen = ++this.sendGen;
        this.stateOwner = null;
        globalStore.set(this.stateAtom, SendingTalk);
        const existing = await this.lookup();
        if (gen !== this.sendGen) {
            return globalStore.get(this.stateAtom);
        }
        if (existing?.status === "none") {
            globalStore.set(this.stateAtom, StartingTalk);
        }
        const sentAt = Date.now() - SentSlackMs;
        let state: TalkState;
        try {
            const result: SayResult = await this.call(
                SayCommand,
                {
                    workspaceid: globalStore.get(atoms.workspace)?.oid ?? "",
                    name: globalStore.get(model.nameAtom),
                    text,
                },
                SayTimeoutMs
            );
            this.keep(result);
            state = talkStateOf(result);
        } catch (e) {
            console.log("brokk session: the message did not go", e);
            state = talkStateOf(null);
        }
        if (gen !== this.sendGen) {
            return state;
        }
        if (state.phase !== "answering") {
            // The first answer, if one is still coming, keeps coming: nothing was taken.
            globalStore.set(this.stateAtom, state);
            return state;
        }
        if (this.lead === lead) {
            this.lead = "";
        }
        await this.takeOver(text, sentAt, state, gen);
        return state;
    }

    // His agent has the message: the answer before it is read to its end, the message joins the exchange, and its answer
    // is followed.
    private async takeOver(text: string, sentAt: number, state: TalkState, gen: number): Promise<void> {
        const prior = this.tracked;
        if (prior != null && !prior.stopped) {
            prior.stopped = true;
            await this.readToItsEnd(prior);
        }
        if (gen !== this.sendGen) {
            return;
        }
        const tracked: Tracked = { id: `m${++this.counter}`, text, sentAt, turn: 0, markdown: "", stopped: false };
        globalStore.set(this.exchangeAtom, (items) => withMessage(items, tracked.id, text, Date.now()));
        this.tracked = tracked;
        this.stateOwner = tracked.id;
        globalStore.set(this.stateAtom, state);
        void this.follow(tracked, state);
    }

    // The answer of an earlier message, read once more by its turn: a newer turn does not change it.
    private async readToItsEnd(tracked: Tracked): Promise<void> {
        let reply: ReplyResult = null;
        try {
            reply = await this.call(ReplyCommand, { after: tracked.sentAt, index: tracked.turn }, FindTimeoutMs);
        } catch (e) {
            console.log("brokk session: his earlier answer could not be read", e);
        }
        if (reply?.status === "answer") {
            this.keepAnswer(tracked, reply, true);
            return;
        }
        this.finish(tracked);
    }

    private keepAnswer(tracked: Tracked, reply: ReplyResult, final: boolean): void {
        const markdown = reply.markdown ?? "";
        const changed = markdown !== tracked.markdown;
        tracked.markdown = markdown;
        tracked.turn = reply.index ?? tracked.turn;
        globalStore.set(this.exchangeAtom, (items) =>
            withAnswer(items, tracked.id, { markdown, turn: tracked.turn, at: reply.at ?? Date.now(), final })
        );
        if (changed || final) {
            this.told(tracked, final);
        }
        if (!changed) {
            return;
        }
        this.speaks();
        if (!this.windowOpen) {
            globalStore.set(this.unseenIdAtom, tracked.id);
        }
    }

    // His agent is done with the message: what was read of its answer will not change.
    private finish(tracked: Tracked): void {
        if (tracked.markdown === "") {
            return;
        }
        globalStore.set(this.exchangeAtom, (items) =>
            withAnswer(items, tracked.id, {
                markdown: tracked.markdown,
                turn: tracked.turn,
                at: Date.now(),
                final: true,
            })
        );
        this.told(tracked, true);
    }

    // He speaks while his answer comes in and for a short while after it last changed.
    private speaks(): void {
        const gen = ++this.speakGen;
        globalStore.set(this.speakingAtom, true);
        void this.wait(SpeakingHoldMs).then(() => {
            if (gen === this.speakGen) {
                globalStore.set(this.speakingAtom, false);
            }
        });
    }

    // Reads his answer until his agent is done with the message, or gives up and points to his terminal.
    private async follow(tracked: Tracked, state: TalkState): Promise<void> {
        const hub = BrokkHubModel.getInstance();
        let follow = StartFollow;
        const until = Date.now() + MaxFollowMs;
        while (!tracked.stopped) {
            await this.wait(FollowEveryMs);
            if (tracked.stopped) {
                return;
            }
            let reply: ReplyResult = null;
            try {
                reply = await this.call(ReplyCommand, { after: tracked.sentAt, index: tracked.turn }, FindTimeoutMs);
            } catch (e) {
                console.log("brokk session: his answer could not be read", e);
            }
            if (tracked.stopped) {
                return;
            }
            const working = globalStore.get(hub.ownWorkingAtom) === true;
            const waiting = globalStore.get(hub.ownWaitingAtom) === true;
            const step = followStep(state, follow, reply, working, waiting);
            state = step.state;
            follow = step.follow;
            if (!step.done && Date.now() > until) {
                state = { ...state, phase: "noreply" };
                step.done = true;
            }
            if (reply?.status === "answer") {
                this.keepAnswer(tracked, reply, step.done);
            } else if (step.done) {
                this.finish(tracked);
            }
            if (this.stateOwner === tracked.id) {
                globalStore.set(this.stateAtom, state);
            }
            if (step.done) {
                tracked.stopped = true;
                return;
            }
        }
    }

    // The developer writes again: the note of a failed message goes. An answer that is still coming is not touched.
    clearNote(): void {
        if (this.stateOwner == null) {
            globalStore.set(this.stateAtom, IdleTalk);
        }
    }
}
