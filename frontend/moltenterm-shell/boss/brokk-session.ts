// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's side of Brokk's own terminal session (FR-BOSS-009, AC15, #2003): the field at the foot of his panel gives
// its messages to wavesrv (pkg/molten/brokksession), which starts the session on the first one and types the next ones
// into it. The block of that session is kept on the hub's model, so that the ring around his avatar turns while its agent
// works. Nothing starts without a message the developer sends.
//
// His session works in a hidden tab: once his agent has a message, its answer is read back from his transcript and
// shown under the field (#2028), and an answer that cannot be read points to his terminal.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom } from "jotai";
import { BossBubbleModel } from "./boss-store";
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

export class BrokkSession {
    private static instance: BrokkSession = null;

    // The last answer to a message, for the line under the field, and his reply.
    stateAtom = atom(IdleTalk) as PrimitiveAtom<TalkState>;

    private call: Call = LiveCall;
    private wait: Wait = LiveWait;
    // A new message, or the note cleared, ends the following of the previous answer.
    private followGen = 0;

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

    // Gives the message to his session, starting it when it does not exist, then follows his answer. Resolves with
    // what came of the message.
    async say(text: string): Promise<TalkState> {
        const model = BossBubbleModel.getInstance();
        const gen = ++this.followGen;
        globalStore.set(this.stateAtom, SendingTalk);
        const existing = await this.lookup();
        if (gen !== this.followGen) {
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
        if (gen !== this.followGen) {
            return state;
        }
        globalStore.set(this.stateAtom, state);
        if (state.phase === "answering") {
            void this.follow(gen, sentAt, state);
        }
        return state;
    }

    // Reads his answer until his agent is done with the message, or gives up and points to his terminal.
    private async follow(gen: number, sentAt: number, state: TalkState): Promise<void> {
        const hub = BrokkHubModel.getInstance();
        let follow = StartFollow;
        const until = Date.now() + MaxFollowMs;
        while (gen === this.followGen) {
            await this.wait(FollowEveryMs);
            if (gen !== this.followGen) {
                return;
            }
            let reply: ReplyResult = null;
            try {
                reply = await this.call(ReplyCommand, { after: sentAt }, FindTimeoutMs);
            } catch (e) {
                console.log("brokk session: his answer could not be read", e);
            }
            if (gen !== this.followGen) {
                return;
            }
            const working = globalStore.get(hub.ownWorkingAtom) === true;
            const step = followStep(state, follow, reply, working);
            state = step.state;
            follow = step.follow;
            if (!step.done && Date.now() > until) {
                state = { ...state, phase: "noreply" };
                step.done = true;
            }
            globalStore.set(this.stateAtom, state);
            if (step.done) {
                return;
            }
        }
    }

    // The developer writes again: the note of the last message goes, his answer with it.
    clearNote(): void {
        this.followGen++;
        globalStore.set(this.stateAtom, IdleTalk);
    }
}
