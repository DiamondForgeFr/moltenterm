// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The last trace of use of each agent, read from wavesrv's recorder (#2431): the same answer Brokk's usage gauges read
// (boss-usage-use.ts), asked here by the choose-an-agent lists. The pure ranking is providers-in-use.ts.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useEffect, useState } from "react";
import { AgentStatesRoute, AgentUseCommand } from "../agent-state-model";

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

// The last uses, read once when the component mounts; {} until they arrive.
export function useProviderLastUse(): Record<string, number> {
    const [last, setLast] = useState<Record<string, number>>({});
    useEffect(() => {
        let live = true;
        readProviderLastUse().then((next) => {
            if (live) {
                setLast(next);
            }
        });
        return () => {
            live = false;
        };
    }, []);
    return last;
}
