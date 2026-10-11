// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ControllerSizeSync } from "./term-controller-sync";

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void };

function deferred(): Deferred {
    let resolve: () => void;
    let reject: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function makeSync(opts: { resync?: Deferred; sendFails?: boolean } = {}) {
    const calls: string[] = [];
    const errors: unknown[] = [];
    const resync = opts.resync ?? deferred();
    if (opts.resync == null) {
        resync.resolve();
    }
    const sync = new ControllerSizeSync(
        () => {
            calls.push("resync");
            return resync.promise;
        },
        (ts) => {
            calls.push(`size ${ts.rows}x${ts.cols}`);
            if (opts.sendFails) {
                return Promise.reject(new Error("no controller found for block b1"));
            }
            return Promise.resolve();
        },
        (e) => errors.push(e)
    );
    return { sync, calls, errors, resync };
}

describe("ControllerSizeSync", () => {
    it("resyncs before sending the first size", async () => {
        const resync = deferred();
        const { sync, calls } = makeSync({ resync });
        const done = sync.sync({ rows: 40, cols: 120 });
        await Promise.resolve();
        expect(calls).toEqual(["resync"]);
        resync.resolve();
        await done;
        expect(calls).toEqual(["resync", "size 40x120"]);
    });

    it("resyncs once and only sends later sizes", async () => {
        const { sync, calls } = makeSync();
        await sync.sync({ rows: 40, cols: 120 });
        await sync.sync({ rows: 30, cols: 100 });
        await sync.sync(null);
        expect(calls).toEqual(["resync", "size 40x120", "size 30x100"]);
    });

    it("resyncs without sending a size when the first fit changed nothing", async () => {
        const { sync, calls } = makeSync();
        await sync.sync(null);
        expect(calls).toEqual(["resync"]);
    });

    it("holds a resize that lands during the resync and keeps the order", async () => {
        const resync = deferred();
        const { sync, calls } = makeSync({ resync });
        const a = sync.sync({ rows: 40, cols: 120 });
        const b = sync.sync({ rows: 42, cols: 130 });
        await Promise.resolve();
        expect(calls).toEqual(["resync"]);
        resync.resolve();
        await Promise.all([a, b]);
        expect(calls).toEqual(["resync", "size 40x120", "size 42x130"]);
    });

    it("reports failures instead of leaving them uncaught", async () => {
        const resync = deferred();
        const { sync, errors } = makeSync({ resync, sendFails: true });
        resync.reject(new Error("resync failed"));
        await sync.sync({ rows: 40, cols: 120 });
        expect(errors.map((e) => (e as Error).message)).toEqual(["resync failed", "no controller found for block b1"]);
    });
});
