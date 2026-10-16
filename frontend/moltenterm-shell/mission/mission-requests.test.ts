// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { MissionRequests } from "./mission-requests";

function deferred<T>() {
    let resolve: (value: T) => void;
    let reject: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

describe("Mission request ownership", () => {
    it.each([false, true])("rejects an obsolete completion (failure=%s)", async (failure) => {
        const owner = new MissionRequests();
        const older = deferred<string>();
        const newer = deferred<string>();
        let value = "cached";
        const read = async (promise: Promise<string>) => {
            const request = owner.begin();
            try {
                const next = await promise;
                if (owner.accepts(request)) value = next;
            } catch {
                if (owner.accepts(request)) value = "error";
            }
        };
        const first = read(older.promise);
        const second = read(newer.promise);
        expect(value).toBe("cached");
        newer.resolve("new");
        await second;
        if (failure) older.reject(new Error("obsolete"));
        else older.resolve("old");
        await first;
        expect(value).toBe("new");
    });

    it("invalidates full snapshots after events while allowing subsequent refreshes", () => {
        const owner = new MissionRequests();
        const first = owner.begin();
        owner.hear();
        expect(owner.accepts(first, true)).toBe(false);
        expect(owner.accepts(first)).toBe(true);
        expect(owner.accepts(owner.begin(), true)).toBe(true);
    });

    it("does not revive an earlier A lifetime after A to B to A", () => {
        const firstA = new MissionRequests();
        const request = firstA.begin();
        firstA.dispose();
        const secondA = new MissionRequests();
        expect(secondA.accepts(secondA.begin())).toBe(true);
        expect(firstA.accepts(request)).toBe(false);
        expect(firstA.begin()).toBeNull();
        expect(firstA.hear()).toBe(false);
    });
});
