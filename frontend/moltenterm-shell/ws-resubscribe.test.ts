// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { onEventsResubscribed, resubscribeAfterRoute, routeFirstReconnectHandler } from "./ws-resubscribe";

function deferred() {
    let resolve: () => void;
    let reject: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

// The order wavesrv needs (#1949): a subscription that runs before the window's route is bound again is refused, so
// nothing may subscribe before the announce is answered.
describe("resubscribe after a reconnect", () => {
    it("subscribes only once the route announce is answered, then tells the stores", async () => {
        const announce = deferred();
        const steps: string[] = [];
        const off = onEventsResubscribed(() => steps.push("reload"));
        const done = resubscribeAfterRoute(
            () => announce.promise,
            () => steps.push("subscribe")
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(steps).toEqual([]);
        announce.resolve();
        await done;
        expect(steps).toEqual(["subscribe", "reload"]);
        off();
    });

    it("still subscribes when the announce fails", async () => {
        const announce = deferred();
        const resubscribe = vi.fn();
        const done = resubscribeAfterRoute(() => announce.promise, resubscribe);
        announce.reject(new Error("timeout"));
        await done;
        expect(resubscribe).toHaveBeenCalledTimes(1);
    });

    it("the reconnect handler announces the routes, asks the control route for an answer, then subscribes", async () => {
        const announce = deferred();
        const steps: string[] = [];
        const client = {
            wshRpcCall: vi.fn((command: string, _data: any, opts: RpcOpts) => {
                steps.push(`${command}@${opts.route}`);
                return announce.promise;
            }),
        };
        const handler = routeFirstReconnectHandler(
            client,
            () => steps.push("reannounce"),
            () => steps.push("subscribe")
        );
        handler();
        await Promise.resolve();
        expect(steps).toEqual(["reannounce", "routeannounce@$control"]);
        announce.resolve();
        await vi.waitFor(() => expect(steps).toEqual(["reannounce", "routeannounce@$control", "subscribe"]));
    });

    it("a listener that throws does not stop the others", async () => {
        const second = vi.fn();
        const offA = onEventsResubscribed(() => {
            throw new Error("boom");
        });
        const offB = onEventsResubscribed(second);
        await resubscribeAfterRoute(
            () => Promise.resolve(),
            () => {}
        );
        expect(second).toHaveBeenCalledTimes(1);
        offA();
        offB();
    });
});
