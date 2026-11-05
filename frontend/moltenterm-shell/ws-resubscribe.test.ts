// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { onEventsResubscribed, reconnectHandler } from "./ws-resubscribe";

// The order wavesrv binds in (#1949, pkg/wshutil/moltenterm_announceorder_test.go covers the server side): announces
// first, then the subscriptions, then the stores read wavesrv's state again, all in the same turn with no wait.
describe("resubscribe after a reconnect", () => {
    it("announces, subscribes, then tells the stores, without waiting", () => {
        const steps: string[] = [];
        const off = onEventsResubscribed(() => steps.push("reload"));
        reconnectHandler(
            () => steps.push("announce"),
            () => steps.push("subscribe")
        )();
        expect(steps).toEqual(["announce", "subscribe", "reload"]);
        off();
    });

    it("a listener that throws does not stop the others, and one removed is not told", () => {
        const second = vi.fn();
        const removed = vi.fn();
        const offA = onEventsResubscribed(() => {
            throw new Error("boom");
        });
        const offB = onEventsResubscribed(second);
        onEventsResubscribed(removed)();
        reconnectHandler(
            () => {},
            () => {}
        )();
        expect(second).toHaveBeenCalledTimes(1);
        expect(removed).not.toHaveBeenCalled();
        offA();
        offB();
    });
});
