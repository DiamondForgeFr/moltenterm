// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { makeMaterialsRefresh } from "./materials-refresh";

function deferred<T>() {
    let resolve: (value: T) => void;
    let reject: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

describe("materials refresh", () => {
    it("coalesces bursts, invalidates the old result and performs a trailing read", async () => {
        const first = deferred<string>();
        const last = deferred<string>();
        const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
        const publish = vi.fn();
        const refresh = makeMaterialsRefresh<string>();
        refresh.activate(read, publish, vi.fn());
        refresh.request();
        refresh.request();
        refresh.request();
        expect(read).toHaveBeenCalledTimes(1);
        first.resolve("deleted");
        await first.promise;
        expect(publish).not.toHaveBeenCalled();
        expect(read).toHaveBeenCalledTimes(2);
        last.resolve("current");
        await last.promise;
        expect(publish).toHaveBeenCalledExactlyOnceWith("current");
    });

    it("serializes workspace switches and discards a late result after unmount", async () => {
        const old = deferred<string>();
        const next = deferred<string>();
        const oldPublish = vi.fn();
        const publish = vi.fn();
        const refresh = makeMaterialsRefresh<string>();
        const close = refresh.activate(() => old.promise, oldPublish, vi.fn());
        close();
        const read = vi.fn().mockReturnValue(next.promise);
        const unmount = refresh.activate(read, publish, vi.fn());
        expect(read).not.toHaveBeenCalled();
        old.resolve("old workspace");
        await old.promise;
        expect(oldPublish).not.toHaveBeenCalled();
        expect(read).toHaveBeenCalledOnce();
        unmount();
        next.resolve("unmounted");
        await next.promise;
        expect(publish).not.toHaveBeenCalled();
    });

    it("drops obsolete errors and can recover after a current failure", async () => {
        const stale = deferred<string>();
        const fail = vi.fn();
        const read = vi
            .fn()
            .mockReturnValueOnce(stale.promise)
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce("ready");
        const publish = vi.fn();
        const refresh = makeMaterialsRefresh<string>();
        refresh.activate(read, publish, fail);
        refresh.request();
        stale.reject(new Error("stale"));
        await stale.promise.catch(() => {});
        await vi.waitFor(() => expect(fail).toHaveBeenCalledOnce());
        expect((fail.mock.calls[0][0] as Error).message).toBe("offline");
        refresh.request();
        await vi.waitFor(() => expect(publish).toHaveBeenCalledWith("ready"));
    });
});
