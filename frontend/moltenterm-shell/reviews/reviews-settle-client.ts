// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The developer settles the stop an agent made for a decision (#1876, FR-REV-022 AC20): the card's "Mark the stop as
// settled" and Mark ready from the card. The lead's way is `molten agent decision settle`; both reach the same state of
// wavesrv (pkg/molten/attention/agenthold.go), which the windows read back with the agent's state.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { AgentStatesRoute, AgentStopSettleCommand, type AgentStopSettleStatus } from "../agent-state-model";
import { errorPhrase, phrase, type Phrase } from "../i18n/phrase";
import type { AgentBarFacts } from "./reviews-upcoming-model";

const SettleTimeoutMs = 5000;

// The panels of a card whose stop MoltenTerm holds for the developer: those it can settle.
export function settlableAgents(agents: readonly AgentBarFacts[]): AgentBarFacts[] {
    return (agents ?? []).filter((a) => a.kind === "panel" && a.state === "waiting" && a.held != null && !!a.blockId);
}

export async function settleStop(blockId: string, note: string): Promise<AgentStopSettleStatus> {
    const res = await TabRpcClient.wshRpcCall(
        AgentStopSettleCommand,
        { blockid: blockId, note },
        { route: AgentStatesRoute, timeout: SettleTimeoutMs }
    );
    return (res as { status?: AgentStopSettleStatus })?.status ?? "none";
}

// settleFromCard: the card's menu entry. The problem to show, or null when the stop is settled.
export async function settleFromCard(blockId: string, note: string): Promise<Phrase> {
    try {
        const status = await settleStop(blockId, note);
        if (status === "settled") {
            return null;
        }
        return phrase(status === "ownprompt" ? "reviews.card.settle.ownPrompt" : "reviews.card.settle.none");
    } catch (e) {
        return errorPhrase(e);
    }
}

// settleAll: the stops of the card's agents, best effort and silent (a card marked ready: the developer decided it).
export async function settleAll(agents: readonly AgentBarFacts[], note: string): Promise<void> {
    for (const agent of settlableAgents(agents)) {
        try {
            await settleStop(agent.blockId, note);
        } catch (e) {
            console.log("reviews: could not settle the stop of", agent.blockId, e);
        }
    }
}
