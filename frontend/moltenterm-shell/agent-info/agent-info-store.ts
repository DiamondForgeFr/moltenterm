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

const SeenStorageKey = "molten:sidebar:seensubs";
const SeenMaxIds = 300;

function readStoredSeen(): Record<string, Record<string, boolean>> {
    try {
        const parsed = JSON.parse(localStorage.getItem(SeenStorageKey) ?? "{}");
        return parsed != null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

// Keeps the latest ids only, so the stored list does not grow for ever.
function trimSeen(all: Record<string, Record<string, boolean>>): Record<string, Record<string, boolean>> {
    const flat = Object.entries(all).flatMap(([blockId, ids]) => Object.keys(ids).map((id) => [blockId, id]));
    const rtn: Record<string, Record<string, boolean>> = {};
    for (const [blockId, id] of flat.slice(-SeenMaxIds)) {
        rtn[blockId] = { ...(rtn[blockId] ?? {}), [id]: true };
    }
    return rtn;
}

export class AgentInfoModel {
    private static instance: AgentInfoModel = null;

    historyAtom = atom([]) as PrimitiveAtom<HandoffHistoryEntry[]>;
    // The agent terminal whose window is open; null when none is.
    openAtom = atom(null) as PrimitiveAtom<string>;
    treesAtom = atom(readStoredTrees()) as PrimitiveAtom<AgentTreeStates>;
    // The sub-agent whose own card is open (FR-SHELL-104): its parent's terminal and its id; null when none is.
    openSubAtom = atom(null) as PrimitiveAtom<{ blockId: string; id: string }>;
    // The sub-agents whose card was opened (a failure stays listed until then), per agent terminal.
    seenSubsAtom = atom(readStoredSeen()) as PrimitiveAtom<Record<string, Record<string, boolean>>>;
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
        globalStore.set(this.openSubAtom, null);
        globalStore.set(this.openAtom, blockId);
    }

    close(): void {
        globalStore.set(this.openAtom, null);
    }

    openSub(blockId: string, id: string): void {
        if (!blockId || !id) {
            return;
        }
        globalStore.set(this.openAtom, null);
        this.markSubSeen(blockId, id);
        globalStore.set(this.openSubAtom, { blockId, id });
    }

    closeSub(): void {
        globalStore.set(this.openSubAtom, null);
    }

    markSubSeen(blockId: string, id: string): void {
        const all = globalStore.get(this.seenSubsAtom);
        if (!blockId || !id || all[blockId]?.[id]) {
            return;
        }
        const next = { ...all, [blockId]: { ...(all[blockId] ?? {}), [id]: true } };
        globalStore.set(this.seenSubsAtom, next);
        try {
            localStorage.setItem(SeenStorageKey, JSON.stringify(trimSeen(next)));
        } catch {
            // A private window keeps what was seen for this session only.
        }
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
