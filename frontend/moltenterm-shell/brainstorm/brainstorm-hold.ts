// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The one flag of the brainstorm mode's pause (FR-BOSS-010 AC3, DS-BOSS-011, #2246): while it holds, the toasts of the
// notifications (notification-toasts.ts) and Brokk's visits (brokk-hub-store.ts) wait, and Electron main holds the
// system notifications. The notifications still reach the center and the badge still counts. The brainstorm store sets
// it from wavesrv's state; the readers only ask. It imports nothing, so the toasts and the hub pay nothing for it.

let held = false;

export function brainstormHolds(): boolean {
    return held;
}

export function setBrainstormHold(on: boolean): void {
    held = on === true;
}
