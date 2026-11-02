// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The windows' copy of wavesrv's agent links (FR-CONT-022): a snapshot at start, then the molten:agentlinks events,
// like the agent states. The handoff pairs are read when the menu opens and while it stays open.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, Atom, PrimitiveAtom } from "jotai";
import { t } from "../i18n/i18n";
import { MoltentermNotifications, NotificationGestureResult } from "../notifications-store";
import {
    AgentLinksControlCommand,
    AgentLinksEvent,
    AgentLinksRouteId,
    AgentLinksStateCommand,
    BlockLinks,
    HandoffForgetCommand,
    HandoffPairsCommand,
    HandoffRouteId,
    LinkAction,
    LinksPlace,
    PairsResult,
    readLinksGestureArgs,
} from "./agent-links-model";

const SnapshotTimeoutMs = 5000;
const SnapshotRetryMs = 2000;
const SnapshotMaxTries = 10;
const ControlTimeoutMs = 5000;

export class AgentLinks {
    private static instance: AgentLinks = null;

    dataAtom = atom({}) as PrimitiveAtom<Record<string, BlockLinks>>;
    blockAtoms = new Map<string, Atom<BlockLinks>>();
    // A notification asked to open the menu on a terminal (#1029's notice); its header opens it once mounted.
    openRequestAtom = atom(null) as PrimitiveAtom<{ blockid: string; at: number }>;
    started = false;

    private constructor() {}

    static getInstance(): AgentLinks {
        if (!AgentLinks.instance) {
            AgentLinks.instance = new AgentLinks();
            AgentLinks.instance.start();
        }
        return AgentLinks.instance;
    }

    apply(states: BlockLinks[]): void {
        if (states == null || states.length === 0) {
            return;
        }
        const next = { ...globalStore.get(this.dataAtom) };
        for (const s of states) {
            if (s?.blockid) {
                next[s.blockid] = s;
            }
        }
        globalStore.set(this.dataAtom, next);
    }

    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;
        try {
            waveEventSubscribeSingle({
                eventType: AgentLinksEvent as WaveEventName,
                handler: (event) => this.apply([event.data as BlockLinks]),
            });
        } catch (e) {
            console.log("agent links: no event bus", e);
            return;
        }
        let tries = 0;
        const load = () => {
            fireAndForget(async () => {
                try {
                    const snapshot: BlockLinks[] = await TabRpcClient.wshRpcCall(
                        AgentLinksStateCommand,
                        {},
                        { route: AgentLinksRouteId, timeout: SnapshotTimeoutMs }
                    );
                    this.apply(snapshot ?? []);
                } catch {
                    if (++tries < SnapshotMaxTries) {
                        setTimeout(load, SnapshotRetryMs);
                    }
                }
            });
        };
        load();
    }

    blockAtom(blockId: string): Atom<BlockLinks> {
        let rtn = this.blockAtoms.get(blockId);
        if (rtn == null) {
            rtn = atom((get) => (blockId == null ? null : (get(this.dataAtom)[blockId] ?? null)));
            this.blockAtoms.set(blockId, rtn);
        }
        return rtn;
    }

    async refresh(blockId: string): Promise<void> {
        const states: BlockLinks[] = await TabRpcClient.wshRpcCall(
            AgentLinksStateCommand,
            { blockid: blockId },
            { route: AgentLinksRouteId, timeout: SnapshotTimeoutMs }
        );
        this.apply(states ?? []);
    }

    async control(blockId: string, linkKey: string, action: LinkAction): Promise<void> {
        await TabRpcClient.wshRpcCall(
            AgentLinksControlCommand,
            { blockid: blockId, linkkey: linkKey, action },
            { route: AgentLinksRouteId, timeout: ControlTimeoutMs }
        );
    }

    async pairs(blockId: string): Promise<PairsResult> {
        const rtn: PairsResult = await TabRpcClient.wshRpcCall(
            HandoffPairsCommand,
            { blockid: blockId },
            { route: HandoffRouteId, timeout: ControlTimeoutMs }
        );
        return { agents: rtn?.agents ?? [], pending: rtn?.pending ?? [] };
    }

    async forgetPair(blockId: string, otherBlockId: string): Promise<void> {
        await TabRpcClient.wshRpcCall(
            HandoffForgetCommand,
            { blockid: blockId, otherblockid: otherBlockId },
            { route: HandoffRouteId, timeout: ControlTimeoutMs }
        );
    }

    requestOpen(place: LinksPlace): void {
        globalStore.set(this.openRequestAtom, { blockid: place.blockid, at: Date.now() });
    }

    clearOpenRequest(): void {
        globalStore.set(this.openRequestAtom, null);
    }
}

// The "lost its link" notice's action (#1029): to the agent's terminal, with its connections menu open.
export async function openAgentLinksGesture(args: Record<string, any>): Promise<NotificationGestureResult> {
    const place = readLinksGestureArgs(args);
    if (place == null) {
        return { ok: false, error: t("agentLinks.noPlace") };
    }
    AgentLinks.getInstance().requestOpen(place);
    await MoltentermNotifications.getInstance().goTo(place);
    return { ok: true };
}
