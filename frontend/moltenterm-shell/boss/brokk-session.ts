// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's side of Brokk's own terminal session (FR-BOSS-009, AC15, #2003): the field at the foot of his panel gives
// its messages to wavesrv (pkg/molten/brokksession), which starts the session on the first one and types the next ones
// into it. The block of that session is kept on the hub's model, so that the ring around his avatar turns while its agent
// works. Nothing starts without a message the developer sends.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom } from "jotai";
import { BossBubbleModel } from "./boss-store";
import { BrokkHubModel } from "./brokk-hub-store";
import { IdleTalk, SayResult, SendingTalk, TalkState, talkStateOf } from "./brokk-talk-model";

// must match pkg/molten/brokksession/live.go
export const SessionRouteId = "molten:brokk";
export const SessionCommand = "moltenbrokksession";
export const SayCommand = "moltenbrokksay";

const FindTimeoutMs = 8000;
// wavesrv waits up to 90 s for an agent just started to show its prompt.
const SayTimeoutMs = 120000;

type Call = (command: string, data: Record<string, unknown>, timeoutMs: number) => Promise<SayResult>;

const LiveCall: Call = (command, data, timeout) =>
    TabRpcClient.wshRpcCall(command, data, { route: SessionRouteId, timeout });

export class BrokkSession {
    private static instance: BrokkSession = null;

    // The last answer to a message, for the line under the field.
    stateAtom = atom(IdleTalk) as PrimitiveAtom<TalkState>;

    private call: Call = LiveCall;

    static getInstance(): BrokkSession {
        if (BrokkSession.instance == null) {
            BrokkSession.instance = new BrokkSession();
        }
        return BrokkSession.instance;
    }

    static resetInstance(): void {
        BrokkSession.instance = null;
    }

    // Tests give a call of their own.
    useCall(call: Call): void {
        this.call = call;
    }

    private keep(result: SayResult): void {
        if (result?.blockid) {
            globalStore.set(BrokkHubModel.getInstance().sessionBlockAtom, result.blockid);
        }
    }

    // Finds the session a restart left, so that the ring turns for it. Starts nothing.
    async find(): Promise<void> {
        try {
            const result = await this.call(SessionCommand, {}, FindTimeoutMs);
            if (result?.status === "ready") {
                this.keep(result);
            }
        } catch (e) {
            console.log("brokk session: not found", e);
        }
    }

    // Gives the message to his session, starting it when it does not exist. Resolves with what came of it.
    async say(text: string): Promise<TalkState> {
        const model = BossBubbleModel.getInstance();
        globalStore.set(this.stateAtom, SendingTalk);
        let state: TalkState;
        try {
            const result = await this.call(
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
        globalStore.set(this.stateAtom, state);
        return state;
    }

    clearNote(): void {
        globalStore.set(this.stateAtom, IdleTalk);
    }
}
