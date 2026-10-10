// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The windows' copy of wavesrv's durable sessions (FR-SHELL-020): a snapshot at start, then the molten:sessions
// events, which carry the whole list (a few KB). Nothing is polled from here: wavesrv watches and ticks.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, Atom, PrimitiveAtom } from "jotai";
import { selectAtom } from "jotai/utils";
import {
    applySessions,
    DurableSessionsCleanupCommand,
    DurableSessionsData,
    DurableSessionsEndCommand,
    DurableSessionsEvent,
    DurableSessionsListCommand,
    DurableSessionsReconnectCommand,
    DurableSessionsRoute,
    DurableSessionsShowCommand,
    RailBadge,
    railBadge,
    SessionEndResult,
    SessionLocation,
    SessionsCleanupResult,
} from "./sessions-model";

const SnapshotTimeoutMs = 5000;
const SnapshotRetryMs = 2000;
const SnapshotMaxTries = 10;
const ActionTimeoutMs = 20000;
// Reconnecting may wait on Wave's prompts (a password, a host key).
const ReconnectTimeoutMs = 95000;

export class DurableSessions {
    private static instance: DurableSessions = null;

    // null until the first snapshot or event.
    dataAtom = atom(null) as PrimitiveAtom<DurableSessionsData>;
    runningAgentsAtom: Atom<number>;
    badgeAtom: Atom<RailBadge>;
    started = false;

    private constructor() {
        this.runningAgentsAtom = atom((get) => get(this.dataAtom)?.runningagents ?? 0);
        // Every tab renders the rail: a list that changed elsewhere than the badge does not render it again.
        this.badgeAtom = selectAtom(
            this.dataAtom,
            (data) => railBadge(data),
            (a, b) => a.count === b.count && a.tone === b.tone && a.label === b.label
        );
    }

    static getInstance(): DurableSessions {
        if (!DurableSessions.instance) {
            DurableSessions.instance = new DurableSessions();
            DurableSessions.instance.start();
        }
        return DurableSessions.instance;
    }

    apply(data: DurableSessionsData): void {
        const current = globalStore.get(this.dataAtom);
        const next = applySessions(current, data);
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
                eventType: DurableSessionsEvent as WaveEventName,
                handler: (event) => this.apply(event.data as DurableSessionsData),
            });
        } catch (e) {
            // The preview server has no event bus.
            console.log("sessions: no event bus", e);
            return;
        }
        let tries = 0;
        const load = () => {
            fireAndForget(async () => {
                try {
                    const snapshot: DurableSessionsData = await TabRpcClient.wshRpcCall(
                        DurableSessionsListCommand,
                        {},
                        { route: DurableSessionsRoute, timeout: SnapshotTimeoutMs }
                    );
                    this.apply(snapshot);
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

    private call<T>(command: string, data: any, timeout = ActionTimeoutMs): Promise<T> {
        return TabRpcClient.wshRpcCall(command, data, { route: DurableSessionsRoute, timeout });
    }

    // The tab is the caller's (the route reads it from the window's own route).
    show(id: string): Promise<SessionLocation> {
        return this.call(DurableSessionsShowCommand, { id });
    }

    // A session dropped on a panel (FR-SHELL-060): reattached beside it, on that side.
    showBeside(id: string, targetBlockId: string, split: string): Promise<SessionLocation> {
        return this.call(DurableSessionsShowCommand, { id, targetblockid: targetBlockId, split });
    }

    end(id: string): Promise<SessionEndResult> {
        return this.call(DurableSessionsEndCommand, { id });
    }

    cleanup(ids: string[]): Promise<SessionsCleanupResult> {
        return this.call(DurableSessionsCleanupCommand, { ids });
    }

    reconnect(id: string): Promise<void> {
        return this.call(DurableSessionsReconnectCommand, { id }, ReconnectTimeoutMs);
    }
}
