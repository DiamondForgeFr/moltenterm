// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How loaded this computer is, for the activity popover's strip (#2502, FR-BOSS-009 AC85). wavesrv reads the 1-minute
// load average per core and judges it with a hysteresis (pkg/molten/machineload); a window asks for it only while the
// popover is open, every few seconds, and never in the background.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useEffect, useState } from "react";
import { AgentStatesRoute, MachineLoad, MachineLoadCommand } from "../agent-state-model";

// How often the reading is asked again while the popover shows.
export const LoadPollMs = 5000;
const LoadRpcTimeoutMs = 4000;

export async function readMachineLoad(): Promise<MachineLoad> {
    return await TabRpcClient.wshRpcCall(MachineLoadCommand, null, {
        route: AgentStatesRoute,
        timeout: LoadRpcTimeoutMs,
    });
}

// Whether the strip shows: only for a reading wavesrv knows and judges loaded.
export function showsLoadWarning(load: MachineLoad): boolean {
    return load?.known === true && load.loaded === true;
}

export type LoadWatch = {
    read: () => Promise<MachineLoad>;
    onLoad: (load: MachineLoad) => void;
    every?: number;
    // Injected for a test: the timer functions.
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (timer: unknown) => void;
};

// Asks now, then again every LoadPollMs after each answer (so asks never overlap); the returned function stops it. A
// failed ask leaves the last reading and tries again later.
export function watchMachineLoad(watch: LoadWatch): () => void {
    const setTimer = watch.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = watch.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    let stopped = false;
    let timer: unknown = null;
    const ask = async () => {
        timer = null;
        try {
            const load = await watch.read();
            if (!stopped) {
                watch.onLoad(load);
            }
        } catch (e) {
            console.log("activity: machine load", e);
        }
        if (!stopped) {
            timer = setTimer(ask, watch.every ?? LoadPollMs);
        }
    };
    void ask();
    return () => {
        stopped = true;
        if (timer != null) {
            clearTimer(timer);
            timer = null;
        }
    };
}

// The machine's load while the component shows: nothing is asked before it mounts nor after it unmounts.
export function useMachineLoad(): MachineLoad {
    const [load, setLoad] = useState<MachineLoad>(null);
    useEffect(() => watchMachineLoad({ read: readMachineLoad, onLoad: setLoad }), []);
    return load;
}
