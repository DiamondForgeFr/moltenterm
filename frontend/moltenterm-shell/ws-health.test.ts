// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { reconnectWSIfClosed } from "./ws-health";

function makeWS(state: { open?: boolean; opening?: boolean; noReconnect?: boolean; reconnectTimes?: number }) {
    return {
        open: state.open ?? false,
        opening: state.opening ?? false,
        noReconnect: state.noReconnect ?? false,
        reconnectTimes: state.reconnectTimes ?? 0,
        connectNow: vi.fn(),
    };
}

describe("reconnectWSIfClosed", () => {
    it("reconnects a closed socket at once and resets the back-off", () => {
        const ws = makeWS({ reconnectTimes: 21 });
        expect(reconnectWSIfClosed(ws, "reinit")).toBe(true);
        expect(ws.connectNow).toHaveBeenCalledWith("reinit");
        expect(ws.reconnectTimes).toBe(0);
    });

    it("leaves an open or opening socket alone", () => {
        const open = makeWS({ open: true });
        const opening = makeWS({ opening: true });
        expect(reconnectWSIfClosed(open, "reinit")).toBe(false);
        expect(reconnectWSIfClosed(opening, "reinit")).toBe(false);
        expect(open.connectNow).not.toHaveBeenCalled();
        expect(opening.connectNow).not.toHaveBeenCalled();
    });

    it("respects a socket shut down on purpose", () => {
        const ws = makeWS({ noReconnect: true });
        expect(reconnectWSIfClosed(ws, "reinit")).toBe(false);
        expect(ws.connectNow).not.toHaveBeenCalled();
    });

    it("ignores a missing socket", () => {
        expect(reconnectWSIfClosed(null, "reinit")).toBe(false);
    });
});
