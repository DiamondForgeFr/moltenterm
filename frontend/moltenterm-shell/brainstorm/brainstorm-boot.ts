// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a tab view carries up front of Brokk's thought in 3D (FR-BOSS-010 AC19, NFR-BOSS-009, #2246): the state the
// layer reads, and a small watch that loads the brainstorm (brainstorm-store.ts and what it needs) only when it is
// needed: the mode is on in some view (wavesrv says so at start, or its event comes), the developer starts one, or his
// answer carries a graph block. A window that never brainstorms loads none of it, and a release channel watches nothing.

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom } from "jotai";
import { BrokkSession } from "../boss/brokk-session";
import { currentBrainstormAllowed } from "../build/current-build";
import { hasGraphFence } from "./brainstorm-fence";
import type { BrainstormGraph } from "./brainstorm-graph-model";

// must match pkg/molten/brainstorm/route.go
export const BrainstormRouteId = "molten:brainstorm";
export const StateCommand = "moltenbrainstormstate";
export const OpenCommand = "moltenbrainstormopen";
export const CloseCommand = "moltenbrainstormclose";
export const TurnCommand = "moltenbrainstormturn";
export const BrainstormEvent = "molten:brainstorm";

export const CallTimeoutMs = 8000;

// must match pkg/molten/brainstorm/service.go
export type BrainstormSummary = {
    slug: string;
    title: string;
    dir: string;
    created: number;
    updated: number;
    turns: number;
};

export type BrainstormState = {
    allowed: boolean;
    open: boolean;
    by?: "you" | "brokk";
    // The wavesrv that counted version: each one counts from 0.
    session?: string;
    version: number;
    brainstorm?: BrainstormSummary;
    graph?: BrainstormGraph;
    savedat?: number;
    saveerror?: string;
};

// The mode as wavesrv last told this view; null before it did (and always on a release channel).
export const BrainstormStateAtom = atom(null) as PrimitiveAtom<BrainstormState>;

type Brainstorm = typeof import("./brainstorm-store");

let loading: Promise<Brainstorm> = null;

// The brainstorm, loaded once and started: from then on it follows the mode itself.
export function loadBrainstorm(): Promise<Brainstorm> {
    loading ??= import("./brainstorm-store").then((mod) => {
        mod.BrainstormModel.getInstance().start();
        return mod;
    });
    return loading;
}

// The developer starts a brainstorm (Brokk's menu, the palette, `/brainstorm` in his field). withIdea: the message that
// follows is the idea to put at the centre (#2257).
export async function openBrainstorm(withIdea = false): Promise<void> {
    if (!currentBrainstormAllowed()) {
        return;
    }
    const mod = await loadBrainstorm();
    await mod.BrainstormModel.getInstance().begin(withIdea);
}

let booted = false;

// Watches for what needs the brainstorm, in this view. Returns the stop.
export function bootBrainstorm(): () => void {
    if (booted || !currentBrainstormAllowed()) {
        return () => {};
    }
    booted = true;
    const stops: (() => void)[] = [];
    const stop = () => stops.splice(0).forEach((fn) => fn());
    const wake = () => {
        stop();
        return loadBrainstorm();
    };
    try {
        stops.push(
            waveEventSubscribeSingle({ eventType: BrainstormEvent as WaveEventName, handler: () => void wake() })
        );
    } catch (e) {
        console.log("brainstorm: no event bus", e);
    }
    // His answer with a graph block may open the mode: the brainstorm loads and reads that answer first.
    stops.push(
        BrokkSession.getInstance().listenAnswers((answer) => {
            if (!hasGraphFence(answer.markdown)) {
                return;
            }
            void wake().then((mod) => mod.BrainstormModel.getInstance().onAnswer(answer));
        })
    );
    // The mode is on already (a view opened after it began): the brainstorm loads and takes the screen.
    void readState().then((state) => {
        if (state?.open) {
            void wake();
        }
    });
    return stop;
}

async function readState(): Promise<BrainstormState> {
    try {
        return await TabRpcClient.wshRpcCall(StateCommand, {}, { route: BrainstormRouteId, timeout: CallTimeoutMs });
    } catch (e) {
        console.log("brainstorm: wavesrv did not answer", e);
        return null;
    }
}
