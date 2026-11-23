// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The windows' copy of wavesrv's permission gate (FR-SHELL-018, #2474): the requests held for the companion and the agent
// sessions set to approve their own, read at start and again on every molten:agentpermit event, which carries a version
// only (any wsh client can publish an event under any name, so the state is read from the windows-only route). The
// developer's clicks go back the same way: Allow, Deny, Answer in the terminal, and the Permissions control's choice.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { KeepAwakeRefresh } from "../keepawake-refresh";
import {
    applyPermitState,
    EmptyPermitState,
    PermitAnswerCommand,
    PermitAnswerResult,
    PermitDecision,
    PermitEvent,
    PermitMode,
    PermitModeCommand,
    PermitModeResult,
    PermitPeriod,
    PermitRoute,
    PermitState,
    PermitStateCommand,
    PermitWatch,
    PermitWatchCommand,
    PermitWatchEveryMs,
} from "./companion-permit-model";

const StateTimeoutMs = 5000;
const CommandTimeoutMs = 10000;
const RefreshDelayMs = 50;

export class PermitModel {
    private static instance: PermitModel = null;

    stateAtom = atom(EmptyPermitState) as PrimitiveAtom<PermitState>;
    // What each watched terminal's agent session can do, as wavesrv last said.
    watchesAtom = atom({}) as PrimitiveAtom<Record<string, PermitWatch>>;
    started = false;
    refreshState = new KeepAwakeRefresh<PermitState>(
        () => this.call(PermitStateCommand, {}, StateTimeoutMs),
        (state) => this.apply(state)
    );

    private constructor() {}

    static getInstance(): PermitModel {
        if (!PermitModel.instance) {
            PermitModel.instance = new PermitModel();
            PermitModel.instance.start();
        }
        return PermitModel.instance;
    }

    static resetInstance(): void {
        PermitModel.instance?.refreshState.stop();
        PermitModel.instance = null;
    }

    apply(next: PermitState): void {
        const current = globalStore.get(this.stateAtom);
        const applied = applyPermitState(current, next);
        if (applied !== current) {
            globalStore.set(this.stateAtom, applied);
        }
    }

    // Subscribes first, so no change is missed during the first read.
    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;
        try {
            const unsubscribe = waveEventSubscribeSingle({
                eventType: PermitEvent as WaveEventName,
                handler: () => this.refresh(),
            });
            if (typeof window !== "undefined") {
                window.addEventListener(
                    "unload",
                    () => {
                        unsubscribe();
                        this.refreshState.stop();
                    },
                    { once: true }
                );
            }
        } catch (e) {
            // The preview server has no event bus.
            console.log("permission gate: no event bus", e);
            return;
        }
        this.refreshState.request();
    }

    // Changes that come close together make one read.
    refresh(): void {
        this.refreshState.request(RefreshDelayMs);
    }

    private async call<T>(command: string, data: any, timeout = CommandTimeoutMs): Promise<T> {
        return (await TabRpcClient.wshRpcCall(command, data, { route: PermitRoute, timeout })) as T;
    }

    // The developer's click on a held request. A request that is gone (answered in the terminal, past its delay) is
    // reported as such, never as an answer.
    async answer(request: { id: string; blockid: string }, decision: PermitDecision): Promise<PermitAnswerResult> {
        const result = await this.call<PermitAnswerResult>(PermitAnswerCommand, {
            id: request.id,
            blockid: request.blockid,
            decision,
        });
        this.refresh();
        return result;
    }

    // The Permissions control's choice for one agent session; "ask" is Stop.
    async setMode(
        blockId: string,
        sessionId: string,
        mode: PermitMode,
        period?: PermitPeriod
    ): Promise<PermitModeResult> {
        const result = await this.call<PermitModeResult>(PermitModeCommand, {
            blockid: blockId,
            sessionid: sessionId,
            mode,
            period: mode === "for" ? period : undefined,
        });
        this.refresh();
        return result;
    }

    // Says that this window shows the terminal's companion (wavesrv holds its requests only then) and reads what the
    // terminal's agent session can do.
    async watch(blockId: string): Promise<PermitWatch> {
        const result = await this.call<PermitWatch>(PermitWatchCommand, { blockid: blockId }, StateTimeoutMs);
        const current = globalStore.get(this.watchesAtom);
        if (result != null && JSON.stringify(current[blockId]) !== JSON.stringify(result)) {
            globalStore.set(this.watchesAtom, { ...current, [blockId]: result });
        }
        return result;
    }
}

export function usePermitState(): PermitState {
    return useAtomValue(PermitModel.getInstance().stateAtom);
}

const NoWatch: PermitWatch = { blockid: "", available: false, holds: false };

// While the companion of a terminal shows in a window that can be seen, the window says so every few seconds: that is
// what makes wavesrv hold the terminal's requests for it. A hidden window says nothing, so no request waits for a click
// nobody can make. Returns what ends it.
export function startPermitWatch(model: PermitModel, blockId: string, doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document): () => void {
    const tell = () => {
        if (doc.visibilityState === "hidden") {
            return;
        }
        model.watch(blockId).catch((e) => console.log("permission gate: watch failed", e));
    };
    tell();
    const timer = setInterval(tell, PermitWatchEveryMs);
    doc.addEventListener("visibilitychange", tell);
    return () => {
        clearInterval(timer);
        doc.removeEventListener("visibilitychange", tell);
    };
}

export function usePermitWatch(blockId: string): PermitWatch {
    const model = PermitModel.getInstance();
    const watches = useAtomValue(model.watchesAtom);
    useEffect(() => (blockId ? startPermitWatch(model, blockId) : undefined), [blockId]);
    return watches[blockId] ?? NoWatch;
}

// A clock for what counts down on screen: ticks while `active`, once a second.
export function useTick(active: boolean, everyMs = 1000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) {
            return;
        }
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), everyMs);
        return () => clearInterval(timer);
    }, [active, everyMs]);
    return now;
}
