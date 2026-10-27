// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The window's copy of wavesrv's handoff history (FR-SHELL-084): read at start and again on each molten:agenthandoffs
// event. Also which agent's "Everything about" window is open, and the sidebar's agent trees, opened or closed.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom } from "jotai";
import {
    HandoffHistoryCommand,
    HandoffHistoryEntry,
    HandoffHistoryEvent,
    HandoffRouteId,
} from "../agent-links/agent-links-model";
import {
    AgentTreeSection,
    AgentTreeStates,
    readTreeStates,
    toggleSection,
    toggleTree,
} from "../sidebar/sidebar-agents-model";

const HistoryTimeoutMs = 5000;
const HistoryRetryMs = 2000;
const HistoryMaxTries = 10;
const TreesStorageKey = "molten:sidebar:agenttrees";

function readStoredTrees(): AgentTreeStates {
    try {
        return readTreeStates(JSON.parse(localStorage.getItem(TreesStorageKey) ?? "{}"));
    } catch {
        return {};
    }
}

export class AgentInfoModel {
    private static instance: AgentInfoModel = null;

    historyAtom = atom([]) as PrimitiveAtom<HandoffHistoryEntry[]>;
    // The agent terminal whose window is open; null when none is.
    openAtom = atom(null) as PrimitiveAtom<string>;
    treesAtom = atom(readStoredTrees()) as PrimitiveAtom<AgentTreeStates>;
    started = false;

    private constructor() {}

    static getInstance(): AgentInfoModel {
        if (!AgentInfoModel.instance) {
            AgentInfoModel.instance = new AgentInfoModel();
            AgentInfoModel.instance.start();
        }
        return AgentInfoModel.instance;
    }

    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;
        // Each view of the window is its own page: a tree opened in one shows opened in the others.
        try {
            window.addEventListener("storage", (e) => {
                if (e.key === TreesStorageKey) {
                    globalStore.set(this.treesAtom, readStoredTrees());
                }
            });
        } catch {
            // No window in unit tests.
        }
        try {
            waveEventSubscribeSingle({
                eventType: HandoffHistoryEvent as WaveEventName,
                handler: () => this.load(0),
            });
        } catch (e) {
            // The preview server has no event bus.
            console.log("agent info: no event bus", e);
            return;
        }
        this.load(0);
    }

    load(tries: number): void {
        fireAndForget(async () => {
            try {
                const rtn: { entries: HandoffHistoryEntry[] } = await TabRpcClient.wshRpcCall(
                    HandoffHistoryCommand,
                    {},
                    { route: HandoffRouteId, timeout: HistoryTimeoutMs }
                );
                globalStore.set(this.historyAtom, rtn?.entries ?? []);
            } catch {
                // wavesrv still starting: its route comes up with Mission Control.
                if (tries + 1 < HistoryMaxTries) {
                    setTimeout(() => this.load(tries + 1), HistoryRetryMs);
                }
            }
        });
    }

    open(blockId: string): void {
        if (!blockId) {
            return;
        }
        globalStore.set(this.openAtom, blockId);
    }

    close(): void {
        globalStore.set(this.openAtom, null);
    }

    toggleTree(blockId: string): void {
        this.writeTrees(toggleTree(globalStore.get(this.treesAtom), blockId));
    }

    toggleSection(blockId: string, section: AgentTreeSection): void {
        this.writeTrees(toggleSection(globalStore.get(this.treesAtom), blockId, section));
    }

    writeTrees(next: AgentTreeStates): void {
        globalStore.set(this.treesAtom, next);
        try {
            localStorage.setItem(TreesStorageKey, JSON.stringify(next));
        } catch {
            // A private window keeps the trees for this session only.
        }
    }
}
