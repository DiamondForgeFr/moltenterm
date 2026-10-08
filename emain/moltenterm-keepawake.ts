// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// MoltenTerm's own keep-awake (FR-SHELL-023, DS-SHELL-025, DS-SHELL-062): wavesrv decides (pkg/molten/keepawake), Electron
// main holds at most one power save blocker while wavesrv says hold. Only 'prevent-app-suspension': system idle sleep
// is prevented, the display may still sleep and the screen lock. The blocker belongs to this process, so quitting or a
// crash releases it at once (NFR-SHELL-008); wavesrv exiting quits the app.

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { app, powerSaveBlocker } from "electron";
import { fireAndForget } from "../frontend/util/util";
import { ElectronWshClient } from "./emain-wsh";

const KeepAwakeRoute = "molten:keepawake";
const KeepAwakeEvent = "molten:keepawake";
const KeepAwakeStateCommand = "keepawakestate";
const StateTimeoutMs = 5000;
const StateRetryMs = 2000;
const StateMaxTries = 10;

type KeepAwakeHold = { version: number; hold: boolean };

let blockerId: number = null;
let lastVersion = -1;

export function isKeepAwakeHeld(): boolean {
    return blockerId != null && powerSaveBlocker.isStarted(blockerId);
}

function setHold(hold: boolean) {
    if (hold) {
        if (isKeepAwakeHeld()) {
            return;
        }
        blockerId = powerSaveBlocker.start("prevent-app-suspension");
        console.log("molten keep-awake: holding the system sleep blocker", blockerId);
        return;
    }
    if (blockerId == null) {
        return;
    }
    if (powerSaveBlocker.isStarted(blockerId)) {
        powerSaveBlocker.stop(blockerId);
    }
    console.log("molten keep-awake: released the system sleep blocker", blockerId);
    blockerId = null;
}

// Events and the first read may cross: the version only grows, so an older state never undoes a newer one.
function applyState(state: KeepAwakeHold) {
    if (state == null || typeof state.version !== "number") {
        return;
    }
    if (state.version < lastVersion) {
        return;
    }
    lastVersion = state.version;
    setHold(state.hold === true);
}

export function initMoltentermKeepAwake() {
    app.on("will-quit", releaseMoltentermKeepAwake);
    waveEventSubscribeSingle({
        eventType: KeepAwakeEvent as WaveEventName,
        handler: (event) => applyState(event.data as KeepAwakeHold),
    });
    let tries = 0;
    const load = () => {
        fireAndForget(async () => {
            try {
                const state = await ElectronWshClient.wshRpcCall(
                    KeepAwakeStateCommand,
                    {},
                    { route: KeepAwakeRoute, timeout: StateTimeoutMs }
                );
                applyState(state as KeepAwakeHold);
            } catch {
                // The route comes up with Mission Control, a moment after wavesrv answers.
                if (++tries < StateMaxTries) {
                    setTimeout(load, StateRetryMs);
                }
            }
        });
    };
    load();
}

// The process exit releases the blocker anyway; this only makes it immediate when the app quits.
function releaseMoltentermKeepAwake() {
    setHold(false);
}
