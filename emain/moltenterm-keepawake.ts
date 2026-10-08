// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// MoltenTerm's own keep-awake (FR-SHELL-023, DS-SHELL-025, DS-SHELL-062): wavesrv decides (pkg/molten/keepawake), Electron
// main holds at most one power save blocker while wavesrv says hold. Only 'prevent-app-suspension': system idle sleep
// is prevented, the display may still sleep and the screen lock. The blocker belongs to this process, so quitting or a
// crash releases it at once (NFR-SHELL-008); wavesrv exiting quits the app.
// Any wsh client can publish an event under any name: the molten:keepawake event only says the state changed, and the
// state is read back from wavesrv's route, which answers this process and the windows only.

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
// While the blocker is held, the state is read again this often: a missed event never keeps the system awake for
// long.
const HeldResyncMs = 30000;

type KeepAwakeHold = { version: number; hold: boolean };

let blockerId: number = null;
let lastVersion = -1;
let resyncTimer: ReturnType<typeof setInterval> = null;

function isHeld(): boolean {
    return blockerId != null && powerSaveBlocker.isStarted(blockerId);
}

function setHold(hold: boolean) {
    if (hold) {
        if (!isHeld()) {
            blockerId = powerSaveBlocker.start("prevent-app-suspension");
            console.log("molten keep-awake: holding the system sleep blocker", blockerId);
        }
        if (resyncTimer == null) {
            resyncTimer = setInterval(() => readState(0), HeldResyncMs);
        }
        return;
    }
    if (resyncTimer != null) {
        clearInterval(resyncTimer);
        resyncTimer = null;
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

// Reads may cross: the version only grows, so an older state never undoes a newer one.
function applyState(state: KeepAwakeHold) {
    if (state == null || typeof state.version !== "number" || state.version < lastVersion) {
        return;
    }
    lastVersion = state.version;
    setHold(state.hold === true);
}

// tries: how many more times a failed read is retried (the route comes up with Mission Control, a moment after
// wavesrv answers).
function readState(tries: number) {
    fireAndForget(async () => {
        try {
            const state = await ElectronWshClient.wshRpcCall(
                KeepAwakeStateCommand,
                {},
                { route: KeepAwakeRoute, timeout: StateTimeoutMs }
            );
            applyState(state as KeepAwakeHold);
        } catch (e) {
            if (tries > 0) {
                setTimeout(() => readState(tries - 1), StateRetryMs);
                return;
            }
            console.log("molten keep-awake: state read failed", e);
        }
    });
}

export function initMoltentermKeepAwake() {
    app.on("will-quit", () => setHold(false));
    waveEventSubscribeSingle({
        eventType: KeepAwakeEvent as WaveEventName,
        handler: () => readState(1),
    });
    readState(StateMaxTries);
}
