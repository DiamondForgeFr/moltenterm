// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The last trace of use of each agent, read from wavesrv's recorder (#2431): the same answer Brokk's usage gauges read
// (boss-usage-use.ts), kept in one store that the choose-an-agent lists rank by. The pure ranking is providers-in-use.ts.

import { getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom } from "jotai";
import { AgentStatesRoute, AgentUseCommand } from "../agent-state-model";
import { orderProviders, ProviderAgent, ProvidersUseDaysKey, providersUseWindowMs } from "./providers-in-use";

const UseRpcTimeoutMs = 5000;

// The last use (Unix ms) of each agent, {} when wavesrv cannot tell (the preview server has no agent states route).
export async function readProviderLastUse(): Promise<Record<string, number>> {
    try {
        const summary: { agents?: Record<string, { lastat?: number }> } = await TabRpcClient.wshRpcCall(
            AgentUseCommand,
            null,
            { route: AgentStatesRoute, timeout: UseRpcTimeoutMs }
        );
        const last: Record<string, number> = {};
        for (const [id, use] of Object.entries(summary?.agents ?? {})) {
            last[id] = use?.lastat > 0 ? use.lastat : 0;
        }
        return last;
    } catch (e) {
        console.log("providers in use: no use summary", e);
        return {};
    }
}

// What the lists rank by: each agent's last use and the window of recent use from Settings. Empty until refreshed, so a
// list keeps the registry's order when nothing is known.
export type ProviderUseState = { last: Record<string, number>; windowMs: number };

export const ProviderUseAtom: PrimitiveAtom<ProviderUseState> = atom<ProviderUseState>({
    last: {},
    windowMs: providersUseWindowMs(undefined),
});

// Reads the last uses and the window again: at the start of the app and each time a choice of agent opens.
export async function refreshProviderUse(): Promise<void> {
    const last = await readProviderLastUse();
    const days = globalStore.get(getSettingsKeyAtom(ProvidersUseDaysKey));
    globalStore.set(ProviderUseAtom, { last, windowMs: providersUseWindowMs(days) });
}

// rankAgents orders a choice of agents for the developer (#2431): the preferred provider first when installed, then the
// installed ones in use by their last use, then the installed ones not in use, then the ones not installed, each group
// in the order it was given. Pure apart from reading the store, and the same for every provider.
export function rankAgents<T extends ProviderAgent>(
    agents: T[],
    preferred = "",
    state: ProviderUseState = globalStore.get(ProviderUseAtom),
    now: number = Date.now()
): T[] {
    const list = agents ?? [];
    const order = orderProviders(list, (id) => state.last[id] ?? 0, now, state.windowMs, preferred);
    const absent = list.filter((a) => !a?.installed);
    return [...order.shown, ...order.other, ...absent] as T[];
}

// rankAgentIds is rankAgents for a list of installed agents given by id.
export function rankAgentIds(ids: string[], state: ProviderUseState = globalStore.get(ProviderUseAtom)): string[] {
    return rankAgents(
        (ids ?? []).map((id) => ({ id, name: id, installed: true })),
        "",
        state
    ).map((a) => a.id);
}
