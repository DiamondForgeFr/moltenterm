// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

type ReconnectableWS = {
    open: boolean;
    opening: boolean;
    noReconnect: boolean;
    reconnectTimes: number;
    connectNow(desc: string): void;
};

// A cached tab view shown again must talk to wavesrv (#223). Wave's reconnect backs off up to a minute and gives up
// after 20 tries, and timers of a hidden view are throttled: a view whose socket dropped while hidden could come back
// with no connection. Showing it reconnects at once, with a fresh back-off.
export function reconnectWSIfClosed(ws: ReconnectableWS, desc: string): boolean {
    if (ws == null || ws.open || ws.opening || ws.noReconnect) {
        return false;
    }
    ws.reconnectTimes = 0;
    ws.connectNow(desc);
    return true;
}
