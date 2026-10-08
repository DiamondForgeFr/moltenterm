// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The windows' copy of wavesrv's outdated terminals (FR-SHELL-041): a snapshot at start, then the molten:termupdate
// events; and the calls of Update terminal.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, Atom, PrimitiveAtom } from "jotai";
import { addMoltentermNotification } from "../notifications-store";
import {
    applyOutdated,
    EmptyOutdated,
    OutdatedData,
    outdatedOfBlock,
    OutdatedTerminal,
    TermUpdateCheckCommand,
    TermUpdateEvent,
    TermUpdateListCommand,
    TermUpdateOutcome,
    TermUpdateRoute,
    TermUpdateRunCommand,
    updateAllSummary,
} from "./termupdate-model";

const ListTimeoutMs = 5000;
const CheckTimeoutMs = 10000;
// An update may wait for an agent to exit (10 s) and a new shell to start.
const RunTimeoutMs = 60000;
const SnapshotRetryMs = 2000;
const SnapshotMaxTries = 10;

function call<T>(command: string, data: any, timeout: number): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: TermUpdateRoute, timeout });
}

export class TermUpdates {
    private static instance: TermUpdates = null;

    dataAtom = atom(EmptyOutdated) as PrimitiveAtom<OutdatedData>;
    countAtom: Atom<number>;
    blockAtoms = new Map<string, Atom<OutdatedTerminal>>();
    started = false;

    private constructor() {
        this.countAtom = atom((get) => get(this.dataAtom).terminals.length);
    }

    static getInstance(): TermUpdates {
        if (!TermUpdates.instance) {
            TermUpdates.instance = new TermUpdates();
            TermUpdates.instance.start();
        }
        return TermUpdates.instance;
    }

    blockAtom(blockId: string): Atom<OutdatedTerminal> {
        let rtn = this.blockAtoms.get(blockId);
        if (rtn == null) {
            rtn = atom((get) => outdatedOfBlock(get(this.dataAtom), blockId));
            this.blockAtoms.set(blockId, rtn);
        }
        return rtn;
    }

    apply(next: OutdatedData): void {
        const current = globalStore.get(this.dataAtom);
        const merged = applyOutdated(current, next);
        if (merged !== current) {
            globalStore.set(this.dataAtom, merged);
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
                eventType: TermUpdateEvent as WaveEventName,
                handler: (event) => this.apply(event.data as OutdatedData),
            });
        } catch (e) {
            // The preview server has no event bus.
            console.log("terminal updates: no event bus", e);
            return;
        }
        let tries = 0;
        const load = () => {
            fireAndForget(async () => {
                try {
                    this.apply(await call<OutdatedData>(TermUpdateListCommand, {}, ListTimeoutMs));
                } catch (e) {
                    tries++;
                    if (tries < SnapshotMaxTries) {
                        setTimeout(load, SnapshotRetryMs);
                    }
                }
            });
        };
        load();
    }

    check(blockId: string): Promise<TermUpdateOutcome> {
        return call<TermUpdateOutcome>(TermUpdateCheckCommand, { blockid: blockId }, CheckTimeoutMs);
    }

    run(blockId: string, confirmed: boolean): Promise<TermUpdateOutcome> {
        return call<TermUpdateOutcome>(TermUpdateRunCommand, { blockid: blockId, confirmed }, RunTimeoutMs);
    }

    // The palette's "Update outdated terminals": every shell with no agent is updated (one by one: each may be busy);
    // a terminal running an agent keeps its own confirmation, from its header.
    async updateAll(): Promise<void> {
        const terminals = globalStore.get(this.dataAtom).terminals;
        const results: { blockid: string; outcome: TermUpdateOutcome }[] = [];
        for (const t of terminals) {
            if (t.agent) {
                const name = t.agentname || t.agent;
                results.push({
                    blockid: t.blockid,
                    outcome: {
                        status: "needconfirm",
                        message: `${name} runs in one of them: use Update terminal in its header to restart ${name} on its conversation.`,
                    },
                });
                continue;
            }
            try {
                results.push({ blockid: t.blockid, outcome: await this.run(t.blockid, false) });
            } catch (e) {
                results.push({ blockid: t.blockid, outcome: { status: "failed", message: String(e) } });
            }
        }
        const summary = updateAllSummary(results);
        addMoltentermNotification({
            key: "termupdate:all",
            source: "moltenterm",
            title: summary.title,
            message: summary.message,
            kind: summary.kind,
        });
    }
}
