// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How long this computer has had no keyboard or pointer input, in seconds (FR-BOSS-007, AC2, #1958): Brokk sleeps
// while the developer is away from it. Read from the system, not from the page, because each view of a window is a page
// of its own and the developer may be working in another application: neither is being away.

import { powerMonitor } from "electron";
import { handleAppIpc } from "./moltenterm-privileged-ipc";

export const SystemIdleChannel = "moltenterm-system-idle-get";

export function systemIdleSec(): number {
    try {
        return powerMonitor.getSystemIdleTime();
    } catch {
        return 0;
    }
}

let initialized = false;

export function initMoltentermSystemIdle() {
    if (initialized) return;
    initialized = true;
    handleAppIpc(SystemIdleChannel, () => systemIdleSec());
}
