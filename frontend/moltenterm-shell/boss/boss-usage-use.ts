// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What each agent was used over the last 7 days (FR-BOSS-009, AC93 and AC94, #2341), asked of wavesrv over the agent
// states route. The hub's start and Brokk's group ask for it through a dynamic import, so this stays out of the
// JavaScript every view loads up front (NFR-PERF-003, bundle.initialJsMB).

import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { AgentStatesRoute, AgentUseCommand } from "../agent-state-model";
import { UsageUseAtom } from "./boss-usage";
import type { AgentUse, AgentUseSummary } from "./brokk-usage-model";

const UseRpcTimeoutMs = 5000;

// What wavesrv answered, read for the numbers it should hold; null for an answer that holds none.
export function readUseSummary(summary: AgentUseSummary): Record<string, AgentUse> {
    if (summary == null || typeof summary.agents !== "object" || summary.agents == null) {
        return null;
    }
    const positive = (n: number) => (n > 0 ? n : 0);
    const agents: Record<string, AgentUse> = {};
    for (const [id, use] of Object.entries(summary.agents)) {
        agents[id] = {
            workms: positive(use?.workms),
            sessions: positive(use?.sessions),
            lastat: positive(use?.lastat),
        };
    }
    return agents;
}

// Asks the use of each agent over the last 7 days: when the hub starts, when Brokk's group opens, and while it shows.
export async function refreshUsageUse(): Promise<void> {
    try {
        const summary: AgentUseSummary = await TabRpcClient.wshRpcCall(AgentUseCommand, null, {
            route: AgentStatesRoute,
            timeout: UseRpcTimeoutMs,
        });
        const next = readUseSummary(summary);
        if (next != null) {
            globalStore.set(UsageUseAtom, next);
        }
    } catch (e) {
        // The preview server has no agent states route.
        console.log("boss usage: no use summary", e);
    }
}
