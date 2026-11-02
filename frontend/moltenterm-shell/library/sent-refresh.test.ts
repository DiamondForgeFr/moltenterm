// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { makeSentRefresh } from "./sent-refresh";

function deferred<T>() {
    let resolve: (value: T) => void;
    let reject: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

describe("shared access refresh", () => {
    it("runs one scan and coalesces requests until it finishes", async () => {
        const first = deferred<string>();
        const second = deferred<string>();
        const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const publish = vi.fn();
        const refresh = makeSentRefresh<string>();
        refresh.activate(read, publish, vi.fn());
        refresh.request();
        refresh.request();
        expect(read).toHaveBeenCalledTimes(1);
        first.resolve("first");
        await first.promise;
        expect(read).toHaveBeenCalledTimes(2);
        second.resolve("second");
        await second.promise;
        expect(publish.mock.calls).toEqual([["first"], ["second"]]);
    });

    it("invalidates a scan before removal and waits for the mutation to finish", async () => {
        const old = deferred<string>();
        const mutation = deferred<void>();
        const read = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue("removed");
        const publish = vi.fn();
        const refresh = makeSentRefresh<string>();
        refresh.activate(read, publish, vi.fn());
        const changing = refresh.mutate(() => mutation.promise);
        refresh.request();
        old.resolve("stale");
        await old.promise;
        expect(publish).not.toHaveBeenCalled();
        expect(read).toHaveBeenCalledTimes(1);
        mutation.resolve();
        await changing;
        await vi.waitFor(() => expect(publish).toHaveBeenCalledWith("removed"));
    });

    it("undo after remount invalidates the new scan, while undo still works when closed", async () => {
        const old = deferred<string>();
        const afterUndo = deferred<string>();
        const undo = deferred<void>();
        const publish = vi.fn();
        const refresh = makeSentRefresh<string>();
        const initial = vi.fn();
        const close = refresh.activate(vi.fn().mockResolvedValue("initial"), initial, vi.fn());
        await vi.waitFor(() => expect(initial).toHaveBeenCalledOnce());
        close();
        const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(afterUndo.promise);
        const closeAgain = refresh.activate(read, publish, vi.fn());
        const restoring = refresh.mutate(() => undo.promise);
        old.resolve("stale");
        await old.promise;
        expect(publish).not.toHaveBeenCalled();
        undo.resolve();
        await restoring;
        expect(read).toHaveBeenCalledTimes(2);
        afterUndo.resolve("restored");
        await afterUndo.promise;
        expect(publish).toHaveBeenCalledWith("restored");
        closeAgain();
        const action = vi.fn().mockResolvedValue("done");
        expect(await refresh.mutate(action)).toBe("done");
        expect(action).toHaveBeenCalledOnce();
        expect(read).toHaveBeenCalledTimes(2);
    });

    it("keeps a remounted section paused until an earlier mutation finishes", async () => {
        const mutation = deferred<void>();
        const initial = vi.fn();
        const refresh = makeSentRefresh<string>();
        const close = refresh.activate(vi.fn().mockResolvedValue("initial"), initial, vi.fn());
        await vi.waitFor(() => expect(initial).toHaveBeenCalledOnce());
        const changing = refresh.mutate(() => mutation.promise);
        close();
        const read = vi.fn().mockResolvedValue("after");
        const publish = vi.fn();
        refresh.activate(read, publish, vi.fn());
        expect(read).not.toHaveBeenCalled();
        mutation.resolve();
        await changing;
        await vi.waitFor(() => expect(publish).toHaveBeenCalledWith("after"));
        expect(read).toHaveBeenCalledOnce();
    });

    it("stops a disposed scan, serializes remount and recovers after errors", async () => {
        const first = deferred<string>();
        let current: () => boolean;
        const refresh = makeSentRefresh<string>();
        const publish = vi.fn();
        const close = refresh.activate((test) => { current = test; return first.promise; }, publish, vi.fn());
        close();
        expect(current()).toBe(false);
        const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("recovered");
        const error = vi.fn();
        const closeAgain = refresh.activate(read, publish, error);
        expect(read).not.toHaveBeenCalled();
        first.resolve("stale");
        await first.promise;
        await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
        expect(publish).not.toHaveBeenCalled();
        refresh.request();
        await vi.waitFor(() => expect(publish).toHaveBeenCalledWith("recovered"));
        closeAgain();
        refresh.request();
        expect(read).toHaveBeenCalledTimes(2);
    });

    it("continues after the error reporter itself throws", async () => {
        const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("ready");
        const report = vi.fn(() => { throw new Error("reporter"); });
        const publish = vi.fn();
        const refresh = makeSentRefresh<string>();
        refresh.activate(read, publish, report);
        await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
        refresh.request();
        await vi.waitFor(() => expect(publish).toHaveBeenCalledWith("ready"));
    });
});
