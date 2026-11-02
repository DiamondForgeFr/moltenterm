// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The window's copy of wavesrv's handoff history (FR-SHELL-084): read at start and again on each molten:agenthandoffs
// event. Also which agent's "Everything about" window is open, the sidebar's agent trees, opened or closed, and the
// sub-agent failures already seen. The last two live on the agent terminal's block (#1763): every view reads them
// live, they outlive a restart and go with the terminal. They lived in the in-memory session's localStorage before.

import { getBlockMetaKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, Atom, PrimitiveAtom } from "jotai";
import {
    HandoffHistoryCommand,
    HandoffHistoryEntry,
    HandoffHistoryEvent,
    HandoffRouteId,
} from "../agent-links/agent-links-model";
import { dropLegacy, readLegacy } from "../legacy-storage";
import {
    AgentTreeSection,
    AgentTreeState,
    readTreeState,
    readTreeStates,
    toggleSection,
    toggleTree,
} from "../sidebar/sidebar-agents-model";
import { subagentFailureKey, type SubagentRow } from "./agent-info-model";

const HistoryTimeoutMs = 5000;
const HistoryRetryMs = 2000;
const HistoryMaxTries = 10;

export const AgentTreeMetaKey = "molten:agenttree";
export const SeenFailuresMetaKey = "molten:seenfailures";
export const LegacyTreesStorageKey = "molten:sidebar:agenttrees";
export const LegacySeenStorageKey = "molten:sidebar:seenfailures:v2";
// Per agent terminal, the latest ids only, so its meta does not grow for ever.
export const SeenMaxIds = 50;

type Seen = Record<string, string>;

// A value written by this page, shown until the block's meta changes from what it was then: the meta then holds this
// write, or a newer one from another view. A write that fails keeps it for this page.
type Pending<T> = { value: T; base: string };

function stamp(v: unknown): string {
    return JSON.stringify(v ?? null);
}

export function readSeen(raw: unknown): Seen {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        return {};
    }
    const rtn: Seen = {};
    for (const [id, key] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof key === "string") {
            rtn[id] = key;
        }
    }
    return rtn;
}

function trimSeen(seen: Seen): Seen {
    const entries = Object.entries(seen);
    return entries.length <= SeenMaxIds ? seen : Object.fromEntries(entries.slice(-SeenMaxIds));
}

function blockMetaAtom(blockId: string, key: string): Atom<unknown> {
    return getBlockMetaKeyAtom(blockId, key as keyof MetaType);
}

function blockMeta(blockId: string, key: string): unknown {
    return globalStore.get(blockMetaAtom(blockId, key));
}

// An async function: a write that throws (no backend) fails as a promise, whose failure is only logged.
async function writeBlockMeta(blockId: string, meta: Record<string, unknown>): Promise<void> {
    await RpcApi.SetMetaCommand(TabRpcClient, { oref: makeORef("block", blockId), meta: meta as MetaType });
}

function saveBlockMeta(blockId: string, meta: Record<string, unknown>) {
    writeBlockMeta(blockId, meta).catch((e) => console.log("agent info: could not save on the terminal", e));
}

// The old maps, by agent terminal, onto terminals whose meta holds none yet; dropped from localStorage once moved.
export async function migrateLegacy(): Promise<void> {
    const found: string[] = [];
    const writes = new Map<string, Record<string, unknown>>();
    const add = (blockId: string, key: string, value: unknown) => {
        writes.set(blockId, { ...(writes.get(blockId) ?? {}), [key]: value });
    };
    const parse = (raw: string): unknown => {
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    };
    const trees = readLegacy(LegacyTreesStorageKey);
    if (trees != null) {
        found.push(LegacyTreesStorageKey);
        for (const [blockId, state] of Object.entries(readTreeStates(parse(trees)))) {
            add(blockId, AgentTreeMetaKey, state);
        }
    }
    const seen = readLegacy(LegacySeenStorageKey);
    if (seen != null) {
        found.push(LegacySeenStorageKey);
        const all = parse(seen);
        if (all != null && typeof all === "object" && !Array.isArray(all)) {
            for (const [blockId, ids] of Object.entries(all as Record<string, unknown>)) {
                const own = readSeen(ids);
                if (Object.keys(own).length > 0) {
                    add(blockId, SeenFailuresMetaKey, trimSeen(own));
                }
            }
        }
    }
    if (found.length === 0) {
        return;
    }
    let failed = false;
    for (const [blockId, meta] of writes) {
        try {
            const block = await RpcApi.GetMetaCommand(TabRpcClient, { oref: makeORef("block", blockId) });
            const update = Object.fromEntries(Object.entries(meta).filter(([key]) => block?.[key] == null));
            if (Object.keys(update).length > 0) {
                await writeBlockMeta(blockId, update);
            }
        } catch (e) {
            // Kept for the next start of a page; a terminal closed since never takes them, which loses nothing.
            failed = true;
            console.log("agent info: could not move the old values onto the terminal", e);
        }
    }
    if (!failed) {
        dropLegacy(found);
    }
}

let migration: Promise<void> = null;

export function resetMigration() {
    migration = null;
}

export class AgentInfoModel {
    private static instance: AgentInfoModel = null;

    historyAtom = atom([]) as PrimitiveAtom<HandoffHistoryEntry[]>;
    // The agent terminal whose window is open; null when none is.
    openAtom = atom(null) as PrimitiveAtom<string>;
    // The sub-agent whose own card is open (FR-SHELL-104): its parent's terminal and its id; null when none is.
    openSubAtom = atom(null) as PrimitiveAtom<{ blockId: string; id: string }>;
    pendingTreesAtom = atom({}) as PrimitiveAtom<Record<string, Pending<AgentTreeState>>>;
    pendingSeenAtom = atom({}) as PrimitiveAtom<Record<string, Pending<Seen>>>;
    treeAtoms = new Map<string, Atom<AgentTreeState>>();
    seenAtoms = new Map<string, Atom<Seen>>();
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

    static resetInstance(): void {
        AgentInfoModel.instance = null;
    }

    // What the developer opened or closed in an agent terminal's tree.
    treeAtom(blockId: string): Atom<AgentTreeState> {
        let rtn = this.treeAtoms.get(blockId);
        if (rtn == null) {
            const saved = blockMetaAtom(blockId, AgentTreeMetaKey);
            rtn = atom((get) => {
                const meta = get(saved);
                const pending = get(this.pendingTreesAtom)[blockId];
                if (pending != null && pending.base === stamp(meta)) {
                    return pending.value;
                }
                return readTreeState(meta) ?? {};
            });
            this.treeAtoms.set(blockId, rtn);
        }
        return rtn;
    }

    // The failure occurrence shown in each sub-agent card of an agent terminal, by sub-agent id.
    seenAtom(blockId: string): Atom<Seen> {
        let rtn = this.seenAtoms.get(blockId);
        if (rtn == null) {
            const saved = blockMetaAtom(blockId, SeenFailuresMetaKey);
            rtn = atom((get) => {
                const meta = get(saved);
                const pending = get(this.pendingSeenAtom)[blockId];
                if (pending != null && pending.base === stamp(meta)) {
                    return pending.value;
                }
                return readSeen(meta);
            });
            this.seenAtoms.set(blockId, rtn);
        }
        return rtn;
    }

    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;
        if (migration == null) {
            migration = migrateLegacy().catch((e) => console.log("agent info: migration failed", e));
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
        if (!blockId || !row?.id || row.state !== "error") {
            return;
        }
        const seen = globalStore.get(this.seenAtom(blockId));
        const key = subagentFailureKey(row);
        if (seen[row.id] === key) return;
        const { [row.id]: _old, ...rest } = seen;
        const next = trimSeen({ ...rest, [row.id]: key });
        const base = stamp(blockMeta(blockId, SeenFailuresMetaKey));
        globalStore.set(this.pendingSeenAtom, {
            ...globalStore.get(this.pendingSeenAtom),
            [blockId]: { value: next, base },
        });
        saveBlockMeta(blockId, { [SeenFailuresMetaKey]: next });
    }

    toggleTree(blockId: string): void {
        this.writeTree(blockId, toggleTree(globalStore.get(this.treeAtom(blockId))));
    }

    toggleSection(blockId: string, section: AgentTreeSection): void {
        this.writeTree(blockId, toggleSection(globalStore.get(this.treeAtom(blockId)), section));
    }

    writeTree(blockId: string, next: AgentTreeState): void {
        if (!blockId) {
            return;
        }
        const base = stamp(blockMeta(blockId, AgentTreeMetaKey));
        globalStore.set(this.pendingTreesAtom, {
            ...globalStore.get(this.pendingTreesAtom),
            [blockId]: { value: next, base },
        });
        saveBlockMeta(blockId, { [AgentTreeMetaKey]: next });
    }
}
