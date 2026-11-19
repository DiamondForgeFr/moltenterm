// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn() } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wos", () => ({ makeORef: (type: string, id: string) => `${type}:${id}` }));
vi.mock("@/app/store/client-model", () => ({ ClientModel: { getInstance: () => ({ clientAtom: null }) } }));

import { globalStore } from "@/app/store/jotaiStore";
import { HeardMetaKey, ParkedMetaKey } from "./brokk-marks";
import { BrokkMarks, MarksWriteEchoMs } from "./brokk-marks-store";

function fixture(initial: Record<string, unknown> | null) {
    const clock = { now: 1000 };
    let meta = initial;
    const listeners = new Set<() => void>();
    const writes: Record<string, unknown>[] = [];
    const marks = BrokkMarks.getInstance();
    marks.useDeps({
        now: () => clock.now,
        read: () => meta,
        write: (patch) => void writes.push(patch),
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    });
    const echo = (next: Record<string, unknown>) => {
        meta = next;
        listeners.forEach((listener) => listener());
    };
    return { clock, marks, writes, echo };
}

describe("the page's side of the shared marks (#2391)", () => {
    it("reads its own write at once, then what the meta echoes and what the other pages write", () => {
        const f = fixture({ [HeardMetaKey]: 500 });
        const stop = f.marks.start();
        f.marks.write({ [ParkedMetaKey]: "a" });
        expect(f.marks.value(ParkedMetaKey)).toBe("a");
        expect(f.writes).toEqual([{ [ParkedMetaKey]: "a" }]);
        f.echo({ [HeardMetaKey]: 500, [ParkedMetaKey]: "a" });
        f.echo({ [HeardMetaKey]: 900, [ParkedMetaKey]: "b" });
        expect(globalStore.get(f.marks.heardAtAtom)).toBe(900);
        expect(f.marks.value(ParkedMetaKey)).toBe("b");
        stop();
    });

    it("drops a write whose echo never came, so the other pages' marks show", () => {
        const f = fixture({ [HeardMetaKey]: 500 });
        f.marks.write({ [ParkedMetaKey]: "mine" });
        f.clock.now += MarksWriteEchoMs;
        f.echo({ [HeardMetaKey]: 500, [ParkedMetaKey]: "theirs" });
        expect(f.marks.value(ParkedMetaKey)).toBe("theirs");
    });

    it("sets the first moment once the meta is loaded, never over one it holds", () => {
        const unread = fixture(null);
        const stop = unread.marks.start();
        expect(unread.writes).toEqual([]);
        unread.echo({});
        expect(unread.writes).toEqual([{ [HeardMetaKey]: 1000 }]);
        stop();
        const held = fixture({ [HeardMetaKey]: 500 });
        held.marks.refresh();
        expect(held.writes).toEqual([]);
    });
});
