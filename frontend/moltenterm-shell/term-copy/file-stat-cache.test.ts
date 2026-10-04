// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileStatCache } from "./file-stat-cache";

describe("FileStatCache", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    function makeCache(existing: string[]) {
        let now = 1000;
        const calls: { conn: string; cwd: string; paths: string[] }[] = [];
        const cache = new FileStatCache(
            async (conn, cwd, paths) => {
                calls.push({ conn, cwd, paths });
                const rtn: Record<string, FileInfo> = {};
                for (const p of paths) {
                    rtn[p] = existing.includes(p) ? { path: `${cwd}/${p}` } : { path: p, notfound: true };
                }
                return rtn;
            },
            () => now
        );
        return { cache, calls, advance: (ms: number) => (now += ms) };
    }

    it("sends the references of the same moment in one stat per folder", async () => {
        const { cache, calls } = makeCache(["a.ts"]);
        const all = Promise.all([
            cache.stat("", "/p", "a.ts"),
            cache.stat("", "/p", "b.ts"),
            cache.stat("", "/p", "a.ts"),
            cache.stat("", "/q", "a.ts"),
        ]);
        await vi.runAllTimersAsync();
        const [a, b, a2, qa] = await all;
        expect(a?.path).toBe("/p/a.ts");
        expect(b).toBeNull();
        expect(a2?.path).toBe("/p/a.ts");
        expect(qa?.path).toBe("/q/a.ts");
        expect(calls).toEqual([
            { conn: "", cwd: "/p", paths: ["a.ts", "b.ts"] },
            { conn: "", cwd: "/q", paths: ["a.ts"] },
        ]);
    });

    it("answers from the cache, and asks again once a missing file may exist", async () => {
        const { cache, calls, advance } = makeCache([]);
        const first = cache.stat("", "/p", "new.ts");
        await vi.runAllTimersAsync();
        expect(await first).toBeNull();
        expect(await cache.stat("", "/p", "new.ts")).toBeNull();
        expect(calls).toHaveLength(1);
        advance(10_000);
        const again = cache.stat("", "/p", "new.ts");
        await vi.runAllTimersAsync();
        await again;
        expect(calls).toHaveLength(2);
    });

    it("shares absolute paths across folders", async () => {
        const { cache, calls } = makeCache(["/abs/x.go"]);
        const first = cache.stat("", "/p", "/abs/x.go");
        await vi.runAllTimersAsync();
        await first;
        expect(cache.cached("", "/other", "/abs/x.go")).toBeDefined();
        expect(calls).toHaveLength(1);
    });

    it("does not cache a failed stat", async () => {
        const cache = new FileStatCache(async () => {
            throw new Error("connection down");
        });
        const r = cache.stat("ssh", "/p", "a.ts");
        await vi.runAllTimersAsync();
        expect(await r).toBeNull();
        expect(cache.cached("ssh", "/p", "a.ts")).toBeUndefined();
    });
});
