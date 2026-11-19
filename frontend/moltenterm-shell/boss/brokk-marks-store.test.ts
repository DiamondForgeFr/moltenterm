// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
const m = vi.hoisted(() => ({
    setMeta: vi.fn(async () => {}),
    client: { clientAtom: null as unknown, clientId: undefined as string },
}));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: m.setMeta } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wos", () => ({ makeORef: (type: string, id: string) => `${type}:${id}` }));
vi.mock("@/app/store/client-model", () => ({ ClientModel: { getInstance: () => m.client } }));

import { globalStore } from "@/app/store/jotaiStore";
import { atom } from "jotai";
import { HeardMetaKey, ParkedMetaKey, parkedText, parkRow, readParked } from "./brokk-marks";
import { BrokkMarks, MarksWriteEchoMs, pageWrites } from "./brokk-marks-store";

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

    it("applies its change again to another page's write that comes before its echo, so neither mark is lost", () => {
        const f = fixture({ [HeardMetaKey]: 500 });
        const stop = f.marks.start();
        const park = (key: string) => (raw: unknown) => parkedText(parkRow(readParked(raw), key, f.clock.now));
        f.marks.update({ [ParkedMetaKey]: park("mine") });
        // Another page set its own row aside from the same reading, and its write lands first.
        const theirs = park("theirs")(undefined);
        f.echo({ [HeardMetaKey]: 500, [ParkedMetaKey]: theirs });
        const retried = f.writes[f.writes.length - 1][ParkedMetaKey];
        expect(Object.keys(readParked(retried).keys).sort()).toEqual(["mine", "theirs"]);
        // This page's first write lands after it, then the retry: both marks stay.
        f.echo({ [HeardMetaKey]: 500, [ParkedMetaKey]: park("mine")(undefined) });
        expect(f.writes).toHaveLength(2);
        f.echo({ [HeardMetaKey]: 500, [ParkedMetaKey]: retried });
        expect(Object.keys(readParked(f.marks.value(ParkedMetaKey)).keys).sort()).toEqual(["mine", "theirs"]);
        stop();
    });

    it("keeps a write made before the client is known, and sends it once it is", async () => {
        m.setMeta.mockClear();
        m.client.clientId = undefined;
        m.client.clientAtom = atom({ oid: "c1", meta: { [HeardMetaKey]: 500 } });
        BrokkMarks.resetInstance();
        const marks = BrokkMarks.getInstance();
        marks.write({ [ParkedMetaKey]: "early" });
        expect(m.setMeta).not.toHaveBeenCalled();
        m.client.clientId = "c1";
        marks.refresh();
        expect(m.setMeta).toHaveBeenCalledWith({}, { oref: "client:c1", meta: { [ParkedMetaKey]: "early" } });
        m.client.clientAtom = null;
        m.client.clientId = undefined;
        BrokkMarks.resetInstance();
    });

    it("lets only the page the developer is in write what every page computes", () => {
        expect(pageWrites({ visibilityState: "visible", hasFocus: () => true })).toBe(true);
        expect(pageWrites({ visibilityState: "visible", hasFocus: () => false })).toBe(false);
        expect(pageWrites({ visibilityState: "hidden", hasFocus: () => true })).toBe(false);
    });
});
