// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's copy of wavesrv's responsibility chain (FR-REV-035): which agents each lead handed work to, read at
// start and again on each molten:agentchain event. The Integration panel follows a view's agents and their
// sub-agents through it (FR-REV-034).

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom } from "jotai";

// must match pkg/molten/handoffwire/handoffwire.go
export const AgentChainRouteId = "molten:agenthandoff";
export const AgentChainCommand = "moltenagenthandoffchain";
export const AgentChainEvent = "molten:agentchain";

// must match ChainEdge in pkg/molten/handoffwire/handoffwire.go: lead handed work to sub, both by first name.
export type ChainEdge = { lead: string; sub: string; via?: string; at?: number };

const ChainTimeoutMs = 5000;
const ChainRetryMs = 2000;
const ChainMaxTries = 10;

export class AgentChain {
    private static instance: AgentChain = null;

    edgesAtom = atom([]) as PrimitiveAtom<ChainEdge[]>;
    started = false;
    inFlight = false;
    again = false;
    retryTimer: ReturnType<typeof setTimeout> = null;

    private constructor() {}

    static getInstance(): AgentChain {
        if (AgentChain.instance == null) {
            AgentChain.instance = new AgentChain();
            AgentChain.instance.start();
        }
        return AgentChain.instance;
    }

    static resetInstance(): void {
        AgentChain.instance = null;
    }

    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;
        try {
            waveEventSubscribeSingle({ eventType: AgentChainEvent as WaveEventName, handler: () => this.load() });
        } catch (e) {
            // The preview server has no event bus.
            console.log("agent chain: no event bus", e);
            return;
        }
        this.load();
    }

    load(): void {
        if (this.retryTimer != null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.inFlight) {
            this.again = true;
            return;
        }
        this.read(0);
    }

    read(tries: number): void {
        this.inFlight = true;
        fireAndForget(async () => {
            try {
                const rtn: { edges: ChainEdge[] } = await TabRpcClient.wshRpcCall(
                    AgentChainCommand,
                    {},
                    { route: AgentChainRouteId, timeout: ChainTimeoutMs }
                );
                // An event during this read requires a fresh snapshot before publishing it.
                if (!this.again) {
                    globalStore.set(this.edgesAtom, Array.isArray(rtn?.edges) ? rtn.edges : []);
                }
            } catch {
                // wavesrv still starting: its route comes up with Mission Control.
                if (!this.again && tries + 1 < ChainMaxTries) {
                    this.retryTimer = setTimeout(() => {
                        this.retryTimer = null;
                        this.read(tries + 1);
                    }, ChainRetryMs);
                }
            } finally {
                this.inFlight = false;
                if (this.again) {
                    this.again = false;
                    this.load();
                }
            }
        });
    }
}
