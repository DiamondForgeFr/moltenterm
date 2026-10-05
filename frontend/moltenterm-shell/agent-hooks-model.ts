// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The hook setup offer (#221): the header of a terminal whose agent's hooks never reported offers the setup of
// agent-states.md, so its states become precise. wavesrv decides (pkg/molten/agenthooks.go): it reads the agent's
// configuration, read-only, and remembers the dismissed agents. MoltenTerm never writes the agent's configuration.
// Kept apart from the store and the components so the rules can be tested without the app.

import { AgentStateInfo } from "./agent-state-model";

// must match pkg/molten/agenthooks.go
export const AgentHookOfferCommand = "moltenagenthookoffer";
export const AgentHookDismissCommand = "moltenagenthookdismiss";
export const AgentStatesDocCommand = "moltenagentstatesdoc";

// must match AgentHookOffer in pkg/molten/agenthooks.go
export type AgentHookOffer = {
    blockid: string;
    agent?: string;
    agentname?: string;
    show: boolean;
    reason?: string;
    file?: string;
    also?: string;
    brings?: string;
    language?: string;
    snippet?: string;
};

// What the header shows: the offer wavesrv made for this agent, until its hooks report or it is dismissed here.
export function visibleHookOffer(info: AgentStateInfo, offer: AgentHookOffer, dismissed: string[]): AgentHookOffer {
    if (info == null || info.hooked || offer == null || !offer.show) {
        return null;
    }
    if (offer.agent !== info.agent || (dismissed ?? []).includes(info.agent)) {
        return null;
    }
    return offer;
}

// The offer is asked again when the pane's agent changes; once its hooks report there is nothing to ask.
export function hookOfferQueryKey(info: AgentStateInfo): string {
    if (info == null || !info.agent || info.hooked) {
        return "";
    }
    return info.agent;
}

export function dismissedWith(dismissed: string[], agent: string): string[] {
    if (!agent || dismissed.includes(agent)) {
        return dismissed;
    }
    return [...dismissed, agent];
}
