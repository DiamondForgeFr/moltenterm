// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The windows' copy of wavesrv's agent states (FR-SHELL-011): a snapshot at start, then the molten:agentstate
// events. Every window holds all of them, since the rail shows the other workspaces too.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, Atom, PrimitiveAtom } from "jotai";
import {
    AgentStateEvent,
    AgentStateInfo,
    AgentStatesCommand,
    AgentStatesData,
    agentStatesOfBlocks,
    agentStatesOfWorkspace,
    AgentStatesRoute,
    applyAgentStates,
    EmptyAgentStates,
    mostUrgentAgentState,
} from "./agent-state-model";

const SnapshotTimeoutMs = 5000;
const SnapshotRetryMs = 2000;
const SnapshotMaxTries = 10;

export class AgentStates {
    private static instance: AgentStates = null;

    dataAtom = atom(EmptyAgentStates) as PrimitiveAtom<AgentStatesData>;
    blockAtoms = new Map<string, Atom<AgentStateInfo>>();
    workspaceAtoms = new Map<string, Atom<AgentStateInfo>>();
    started = false;

    private constructor() {}

    static getInstance(): AgentStates {
        if (!AgentStates.instance) {
            AgentStates.instance = new AgentStates();
            AgentStates.instance.start();
        }
        return AgentStates.instance;
    }

    apply(infos: AgentStateInfo[]): void {
        const current = globalStore.get(this.dataAtom);
        const next = applyAgentStates(current, infos);
        if (next !== current) {
            globalStore.set(this.dataAtom, next);
        }
    }

    // Subscribes first, so nothing published while the snapshot travels is lost (versions order the two).
    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;
        try {
            waveEventSubscribeSingle({
                eventType: AgentStateEvent as WaveEventName,
                handler: (event) => this.apply([event.data as AgentStateInfo]),
            });
        } catch (e) {
            // The preview server has no event bus.
            console.log("agent states: no event bus", e);
            return;
        }
        let tries = 0;
        const load = () => {
            fireAndForget(async () => {
                try {
                    const snapshot: AgentStateInfo[] = await TabRpcClient.wshRpcCall(
                        AgentStatesCommand,
                        {},
                        { route: AgentStatesRoute, timeout: SnapshotTimeoutMs }
                    );
                    this.apply(snapshot ?? []);
                } catch {
                    // wavesrv still starting: the route comes up with Mission Control.
                    if (++tries < SnapshotMaxTries) {
                        setTimeout(load, SnapshotRetryMs);
                    }
                }
            });
        };
        load();
    }

    blockAtom(blockId: string): Atom<AgentStateInfo> {
        let rtn = this.blockAtoms.get(blockId);
        if (rtn == null) {
            rtn = atom((get) => (blockId == null ? null : (get(this.dataAtom).states[blockId] ?? null)));
            this.blockAtoms.set(blockId, rtn);
        }
        return rtn;
    }

    workspaceAtom(workspaceId: string): Atom<AgentStateInfo> {
        let rtn = this.workspaceAtoms.get(workspaceId);
        if (rtn == null) {
            rtn = atom((get) => mostUrgentAgentState(agentStatesOfWorkspace(get(this.dataAtom), workspaceId)));
            this.workspaceAtoms.set(workspaceId, rtn);
        }
        return rtn;
    }

    // A tab's blocks are read from the tab object (a pane moved to another tab follows it).
    tabAtom(blockIdsAtom: Atom<string[]>): Atom<AgentStateInfo> {
        return atom((get) => mostUrgentAgentState(agentStatesOfBlocks(get(this.dataAtom), get(blockIdsAtom))));
    }
}
