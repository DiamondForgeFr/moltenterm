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
import { subagentFailureKey, type SubagentRow } from "./agent-info-model";

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

const SeenStorageKey = "molten:sidebar:seenfailures:v2";
const SeenMaxIds = 300;

function readStoredSeen(): Record<string, Record<string, string>> {
    try {
        const parsed = JSON.parse(localStorage.getItem(SeenStorageKey) ?? "{}");
        return parsed != null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

// Keeps the latest ids only, so the stored list does not grow for ever.
function trimSeen(all: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
    const flat = Object.entries(all).flatMap(([blockId, ids]) =>
        Object.entries(ids).map(([id, key]) => [blockId, id, key])
    );
    const rtn: Record<string, Record<string, string>> = {};
    for (const [blockId, id, key] of flat.slice(-SeenMaxIds)) {
        rtn[blockId] = { ...(rtn[blockId] ?? {}), [id]: key };
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
    // The failure occurrence shown in each sub-agent card, per agent terminal.
    seenSubsAtom = atom(readStoredSeen()) as PrimitiveAtom<Record<string, Record<string, string>>>;
    started = false;
    historyInFlight = false;
    historyPending = false;
    historyRetryTimer: ReturnType<typeof setTimeout> = null;

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
                handler: () => this.load(),
            });
        } catch (e) {
            // The preview server has no event bus.
            console.log("agent info: no event bus", e);
            return;
        }
        this.load();
    }

    load(): void {
        if (this.historyRetryTimer != null) {
            clearTimeout(this.historyRetryTimer);
            this.historyRetryTimer = null;
        }
        if (this.historyInFlight) {
            this.historyPending = true;
            return;
        }
        this.readHistory(0);
    }

    readHistory(tries: number): void {
        this.historyInFlight = true;
        fireAndForget(async () => {
            try {
                const rtn: { entries: HandoffHistoryEntry[] } = await TabRpcClient.wshRpcCall(
                    HandoffHistoryCommand,
                    {},
                    { route: HandoffRouteId, timeout: HistoryTimeoutMs }
                );
                // An event during this read requires a fresh snapshot before publishing it.
                if (!this.historyPending) globalStore.set(this.historyAtom, rtn?.entries ?? []);
            } catch {
                // wavesrv still starting: its route comes up with Mission Control.
                if (!this.historyPending && tries + 1 < HistoryMaxTries) {
                    this.historyRetryTimer = setTimeout(() => {
                        this.historyRetryTimer = null;
                        this.readHistory(tries + 1);
                    }, HistoryRetryMs);
                }
            } finally {
                this.historyInFlight = false;
                if (this.historyPending) {
                    this.historyPending = false;
                    this.load();
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
        globalStore.set(this.openSubAtom, { blockId, id });
    }

    closeSub(): void {
        globalStore.set(this.openSubAtom, null);
    }

    markSubSeen(blockId: string, row: SubagentRow): void {
        const all = globalStore.get(this.seenSubsAtom);
        if (!blockId || !row?.id || row.state !== "error") {
            return;
        }
        const key = subagentFailureKey(row);
        if (all[blockId]?.[row.id] === key) return;
        const next = { ...all, [blockId]: { ...(all[blockId] ?? {}), [row.id]: key } };
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
