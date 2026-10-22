// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingGate } from "./pending-action";

// A backend call the test answers when it wants: the button stays pending until then.
function deferred<T = boolean | void>() {
    let resolve: (v: T) => void;
    let reject: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function gate() {
    const seen: string[] = [];
    return { g: new PendingGate((p) => seen.push(p)), seen };
}

afterEach(() => {
    vi.useRealTimers();
});

describe("one action at a time on a card (#952)", () => {
    it("is pending from the click until the backend answers, then comes back", async () => {
        const { g, seen } = gate();
        const call = deferred();
        const done = g.run("action:Prepare", () => call.promise, false);
        expect(g.held).toBe("action:Prepare");
        expect(seen).toEqual(["action:Prepare"]);
        call.resolve();
        await expect(done).resolves.toBe(true);
        expect(g.held).toBe("");
        expect(seen).toEqual(["action:Prepare", ""]);
    });

    it("sends one request on a double click, and refuses any other action of the card meanwhile", async () => {
        const { g } = gate();
        const call = deferred();
        const backend = vi.fn(() => call.promise);
        const first = g.run("action:Cut", backend, false);
        const second = g.run("action:Cut", backend, false);
        const other = g.run("abandon", backend, false);
        await expect(second).resolves.toBe(false);
        await expect(other).resolves.toBe(false);
        expect(backend).toHaveBeenCalledTimes(1);
        call.resolve();
        await first;
        expect(backend).toHaveBeenCalledTimes(1);
    });

    it("comes back with the error when the backend fails, and can be clicked again", async () => {
        const { g, seen } = gate();
        const call = deferred();
        const done = g.run("abandon", () => call.promise, true);
        call.reject(new Error("gh: not logged in"));
        await expect(done).rejects.toThrow("gh: not logged in");
        expect(g.held).toBe("");
        expect(g.awaiting).toBe(false);
        expect(seen[seen.length - 1]).toBe("");
        const again = vi.fn(async () => {});
        await expect(g.run("abandon", again, true)).resolves.toBe(true);
        expect(again).toHaveBeenCalledTimes(1);
    });

    it("keeps a started step pending until the card read the release again", async () => {
        const { g } = gate();
        await expect(g.run("action:Prepare", async () => true, true)).resolves.toBe(true);
        expect(g.held).toBe("action:Prepare");
        const backend = vi.fn(async () => true);
        await expect(g.run("action:Prepare", backend, true)).resolves.toBe(false);
        expect(backend).not.toHaveBeenCalled();
        g.revised();
        expect(g.held).toBe("");
        g.dispose();
    });

    it("does not wait for a read when nothing started, or when nothing reads the card", async () => {
        const { g } = gate();
        await g.run("action:Prepare", async () => false, true);
        expect(g.held).toBe("");
        await g.run("action:Prepare", async () => true, false);
        expect(g.held).toBe("");
    });

    it("ignores a read that lands before the answer", async () => {
        const { g } = gate();
        const call = deferred();
        const done = g.run("action:Prepare", () => call.promise, true);
        g.revised();
        expect(g.held).toBe("action:Prepare");
        call.resolve(true);
        await done;
        expect(g.held).toBe("action:Prepare");
        g.revised();
        expect(g.held).toBe("");
    });

    it("comes back by itself when no read follows (a card out of sight stops reading)", async () => {
        vi.useFakeTimers();
        const { g } = gate();
        await g.run("action:Prepare", async () => true, true);
        expect(g.held).toBe("action:Prepare");
        vi.runAllTimers();
        expect(g.held).toBe("");
    });
});
