// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's copy of the first names locked for a project (FR-CONT-014, #2324), read at start and again on each
// molten:agentnamelocks event, and the two commands that change them. wavesrv holds the locks and applies the
// allocator's rules; a window only asks, naming a terminal (the agent's name and project are wavesrv's own).

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom } from "jotai";
import {
    AgentNameLock,
    AgentNameLockCommand,
    AgentNameLockResult,
    AgentNameLocksCommand,
    AgentNameLocksEvent,
    AgentNameUnlockCommand,
    AgentNameUnlockResult,
} from "./agent-name-locks-model";
import { AgentStatesRoute } from "./agent-state-model";

const LocksTimeoutMs = 5000;
const LocksRetryMs = 2000;
const LocksMaxTries = 10;

export class AgentNameLocks {
    private static instance: AgentNameLocks = null;

    locksAtom = atom([]) as PrimitiveAtom<AgentNameLock[]>;
    started = false;
    inFlight = false;
    again = false;
    retryTimer: ReturnType<typeof setTimeout> = null;

    private constructor() {}

    static getInstance(): AgentNameLocks {
        if (AgentNameLocks.instance == null) {
            AgentNameLocks.instance = new AgentNameLocks();
            AgentNameLocks.instance.start();
        }
        return AgentNameLocks.instance;
    }

    static resetInstance(): void {
        AgentNameLocks.instance = null;
    }

    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;
        try {
            waveEventSubscribeSingle({ eventType: AgentNameLocksEvent as WaveEventName, handler: () => this.load() });
        } catch (e) {
            // The preview server has no event bus.
            console.log("agent name locks: no event bus", e);
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
                const rtn: { locks: AgentNameLock[] } = await TabRpcClient.wshRpcCall(
                    AgentNameLocksCommand,
                    {},
                    { route: AgentStatesRoute, timeout: LocksTimeoutMs }
                );
                // An event during this read requires a fresh read before publishing it.
                if (!this.again) {
                    globalStore.set(this.locksAtom, Array.isArray(rtn?.locks) ? rtn.locks : []);
                }
            } catch {
                // wavesrv still starting: its route comes up with the agent states.
                if (!this.again && tries + 1 < LocksMaxTries) {
                    this.retryTimer = setTimeout(() => {
                        this.retryTimer = null;
                        this.read(tries + 1);
                    }, LocksRetryMs);
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

// Locks the first name the agent of a terminal holds for that agent's project. move: take it from the project it is
// locked for, which the caller asks the developer first.
export async function lockAgentName(blockId: string, move: boolean): Promise<AgentNameLockResult> {
    const rtn = await TabRpcClient.wshRpcCall(
        AgentNameLockCommand,
        { blockid: blockId, move },
        { route: AgentStatesRoute, timeout: LocksTimeoutMs }
    );
    return rtn as AgentNameLockResult;
}

export async function unlockAgentName(name: string): Promise<AgentNameUnlockResult> {
    const rtn = await TabRpcClient.wshRpcCall(
        AgentNameUnlockCommand,
        { name },
        { route: AgentStatesRoute, timeout: LocksTimeoutMs }
    );
    return rtn as AgentNameUnlockResult;
}
