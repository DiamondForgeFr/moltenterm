// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The windows' side of the hook setup offer (#221): the offer wavesrv made per terminal, and the agents dismissed
// in this window (wavesrv remembers them for good, so other windows learn it at their next ask).

import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, Atom, PrimitiveAtom } from "jotai";
import {
    AgentHookDismissCommand,
    AgentHookOffer,
    AgentHookOfferCommand,
    AgentStatesDocCommand,
    dismissedWith,
    visibleHookOffer,
} from "./agent-hooks-model";
import { AgentStatesRoute } from "./agent-state-model";
import { AgentStates } from "./agent-state-store";

const RpcTimeoutMs = 5000;

function agentCall<T>(command: string, data: any): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: AgentStatesRoute, timeout: RpcTimeoutMs });
}

export class AgentHookOffers {
    private static instance: AgentHookOffers = null;

    offersAtom = atom({}) as PrimitiveAtom<Record<string, AgentHookOffer>>;
    dismissedAtom = atom([]) as PrimitiveAtom<string[]>;
    visibleAtoms = new Map<string, Atom<AgentHookOffer>>();

    private constructor() {}

    static getInstance(): AgentHookOffers {
        if (!AgentHookOffers.instance) {
            AgentHookOffers.instance = new AgentHookOffers();
        }
        return AgentHookOffers.instance;
    }

    visibleAtom(blockId: string): Atom<AgentHookOffer> {
        let rtn = this.visibleAtoms.get(blockId);
        if (rtn == null) {
            const stateAtom = AgentStates.getInstance().blockAtom(blockId);
            rtn = atom((get) =>
                visibleHookOffer(get(stateAtom), get(this.offersAtom)[blockId], get(this.dismissedAtom))
            );
            this.visibleAtoms.set(blockId, rtn);
        }
        return rtn;
    }

    setOffer(blockId: string, offer: AgentHookOffer): void {
        globalStore.set(this.offersAtom, { ...globalStore.get(this.offersAtom), [blockId]: offer });
    }

    async refresh(blockId: string): Promise<void> {
        try {
            this.setOffer(blockId, await agentCall<AgentHookOffer>(AgentHookOfferCommand, { blockid: blockId }));
        } catch (e) {
            // No offer is better than a wrong one.
            console.log("agent hook offer", e);
            this.setOffer(blockId, null);
        }
    }

    async dismiss(agent: string): Promise<void> {
        globalStore.set(this.dismissedAtom, dismissedWith(globalStore.get(this.dismissedAtom), agent));
        await agentCall(AgentHookDismissCommand, { agent });
    }

    docPath(): Promise<string> {
        return agentCall<string>(AgentStatesDocCommand, {});
    }
}
