// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The preload's side of the hang watch (#849): channels shared with Electron main, and sendSync timed. A sendSync
// blocks the page until Electron main answers, so a busy main freezes the window even when the handler itself is
// instant: the round trip is what counts.

export const HangPingChannel = "moltenterm-hang-ping";
export const HangPongChannel = "moltenterm-hang-pong";
export const SlowSyncIpcChannel = "moltenterm-slow-sync-ipc";
export const WindowHangChannel = "moltenterm-window-hang";
export const HangDiagnosticsChannel = "moltenterm-hang-diagnostics";
// Electron main writes the clipboard: the page's navigator.clipboard refuses when its document lacks the focus.
export const HangCopyChannel = "moltenterm-hang-copy";

type SyncSender = {
    sendSync: (channel: string, ...args: any[]) => any;
    send: (channel: string, ...args: any[]) => void;
};

export function timedSendSync(
    ipc: SyncSender,
    slowMs: number,
    now: () => number,
    channel: string,
    ...args: any[]
): any {
    const start = now();
    const value = ipc.sendSync(channel, ...args);
    const took = now() - start;
    if (took >= slowMs) {
        ipc.send(SlowSyncIpcChannel, channel, Math.round(took));
    }
    return value;
}
