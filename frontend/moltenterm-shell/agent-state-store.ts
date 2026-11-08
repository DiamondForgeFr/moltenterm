// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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
    heldAgentVersions,
    mostUrgentAgentState,
    reconcileAgentStates,
    splitOwnStates,
    workingAgentCount,
} from "./agent-state-model";
import { onEventsResubscribed } from "./ws-resubscribe";

const SnapshotTimeoutMs = 5000;
const SnapshotRetryMs = 2000;
const SnapshotMaxTries = 10;

export class AgentStates {
    private static instance: AgentStates = null;

    // The agents of the workspaces: every list (the sidebar's, the panels', the rail's marks, the counts) reads it.
    dataAtom = atom(EmptyAgentStates) as PrimitiveAtom<AgentStatesData>;
    // Brokk's own session alone (FR-BOSS-009, AC26): it is in no list, and the ring on his face reads it here.
    ownDataAtom = atom(EmptyAgentStates) as PrimitiveAtom<AgentStatesData>;
    // True once the first snapshot is in: what arrives before it is a window starting, not an agent changing state.
    loadedAtom = atom(false) as PrimitiveAtom<boolean>;
    blockAtoms = new Map<string, Atom<AgentStateInfo>>();
    workspaceAtoms = new Map<string, Atom<AgentStateInfo>>();
    workspaceWorkingAtoms = new Map<string, Atom<number>>();
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
        const own = globalStore.get(this.ownDataAtom);
        const split = splitOwnStates(infos, current, own);
        const next = applyAgentStates(current, split.shared);
        if (next !== current) {
            globalStore.set(this.dataAtom, next);
        }
        const nextOwn = applyAgentStates(own, split.own);
        if (nextOwn !== own) {
            globalStore.set(this.ownDataAtom, nextOwn);
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
        this.loadSnapshot();
        // What was published while the websocket was down never came (#1949): an agent started meanwhile would stay
        // a plain terminal until the window reloads.
        onEventsResubscribed(() => this.loadSnapshot(true));
        // Every view of a workspace shows the same agents (#1950): a view coming to the front reads them again, so
        // nothing it missed while hidden, cut off or rebuilt stays on screen.
        if (typeof document !== "undefined") {
            document.addEventListener("visibilitychange", () => {
                if (document.visibilityState === "visible") {
                    this.loadSnapshot(true);
                }
            });
        }
    }

    applySnapshot(
        snapshot: AgentStateInfo[],
        before: Record<string, number>,
        beforeOwn: Record<string, number> = null
    ): void {
        if (before == null) {
            this.apply(snapshot);
            return;
        }
        const current = globalStore.get(this.dataAtom);
        const own = globalStore.get(this.ownDataAtom);
        const split = splitOwnStates(snapshot, current, own);
        const next = reconcileAgentStates(current, before, split.shared);
        if (next !== current) {
            globalStore.set(this.dataAtom, next);
        }
        const nextOwn = reconcileAgentStates(own, beforeOwn, split.own);
        if (nextOwn !== own) {
            globalStore.set(this.ownDataAtom, nextOwn);
        }
    }

    // reconcile: the window may have missed events (a reconnect), so the agents the snapshot no longer lists go.
    loadSnapshot(reconcile = false): void {
        let tries = 0;
        const load = () => {
            const before = reconcile ? heldAgentVersions(globalStore.get(this.dataAtom)) : null;
            const beforeOwn = reconcile ? heldAgentVersions(globalStore.get(this.ownDataAtom)) : null;
            fireAndForget(async () => {
                try {
                    const snapshot: AgentStateInfo[] = await TabRpcClient.wshRpcCall(
                        AgentStatesCommand,
                        {},
                        { route: AgentStatesRoute, timeout: SnapshotTimeoutMs }
                    );
                    this.applySnapshot(snapshot ?? [], before, beforeOwn);
                    globalStore.set(this.loadedAtom, true);
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
            // His own session has no place in a list, but its terminal is a terminal like any other when it is opened.
            rtn = atom((get) =>
                blockId == null
                    ? null
                    : (get(this.dataAtom).states[blockId] ?? get(this.ownDataAtom).states[blockId] ?? null)
            );
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

    // The number of working agents, not the most urgent state: a workspace that waits on one agent still has others at
    // work, and the atom only changes when the count does, so the dots of idle workspaces never render again.
    workspaceWorkingAtom(workspaceId: string): Atom<number> {
        let rtn = this.workspaceWorkingAtoms.get(workspaceId);
        if (rtn == null) {
            rtn = atom((get) => workingAgentCount(agentStatesOfWorkspace(get(this.dataAtom), workspaceId)));
            this.workspaceWorkingAtoms.set(workspaceId, rtn);
        }
        return rtn;
    }

    // A tab's blocks are read from the tab object (a pane moved to another tab follows it).
    tabAtom(blockIdsAtom: Atom<string[]>): Atom<AgentStateInfo> {
        return atom((get) => mostUrgentAgentState(agentStatesOfBlocks(get(this.dataAtom), get(blockIdsAtom))));
    }
}
