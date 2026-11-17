// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's side of Brokk's visit words (FR-BOSS-009, AC82, #2222). A fake clock, a seeded random source and a fake
// meta: nothing here waits.

import { beforeEach, describe, expect, it, vi } from "vitest";

const Sources = vi.hoisted(() => ({
    client: null as any,
    clientId: "client-1" as string,
    setMeta: null as any,
}));
vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/client-model", async () => {
    const { atom } = await import("jotai");
    Sources.client = atom({ meta: {} as Record<string, unknown> });
    return { ClientModel: { getInstance: () => ({ clientAtom: Sources.client, clientId: Sources.clientId }) } };
});
vi.mock("@/app/store/wos", () => ({ makeORef: (type: string, id: string) => `${type}:${id}` }));
vi.mock("@/app/store/wshclientapi", () => {
    Sources.setMeta = vi.fn(async () => {});
    return { RpcApi: { SetMetaCommand: (...args: unknown[]) => Sources.setMeta(...args) } };
});
vi.mock("@/util/util", () => ({ fireAndForget: (run: () => Promise<unknown>) => void run() }));

import { globalStore } from "@/app/store/jotaiStore";
import { decodeWording, encodeWording, VisitPhrasings, VisitReasons, windowOf } from "./brokk-visit-wording";
import { BrokkVisitWords, VisitWordsDeps, WordsMetaKey, WriteEchoMs } from "./brokk-visit-words-store";

// A small deterministic random source (mulberry32).
function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// The client's meta, shared by every window of the fake computer. A write lands in it at once unless `lag` holds it back.
function metaFixture() {
    const state = { text: null as string, writes: [] as string[], now: 1_000_000, lag: false, held: null as string };
    const deps: Partial<VisitWordsDeps> = {
        now: () => state.now,
        read: () => state.text,
        write: (text) => {
            state.writes.push(text);
            if (state.lag) {
                state.held = text;
            } else {
                state.text = text;
            }
        },
    };
    return { state, deps };
}

function fresh(deps: Partial<VisitWordsDeps>): BrokkVisitWords {
    BrokkVisitWords.resetInstance();
    const model = BrokkVisitWords.getInstance();
    model.useDeps(deps);
    return model;
}

beforeEach(() => {
    BrokkVisitWords.resetInstance();
    globalStore.set(Sources.client, { meta: {} });
    Sources.setMeta.mockClear();
    Sources.clientId = "client-1";
});

describe("the sentence of a visit stays while it is up (FR-BOSS-009, AC82)", () => {
    it("draws once for a sentence, however often the scene renders", () => {
        const { state, deps } = metaFixture();
        const calls: number[] = [];
        const random = () => {
            calls.push(1);
            return 0.5;
        };
        const model = fresh({ ...deps, random });
        const first = model.pick("ciFailed", "ciFailed|ci:/work/app:12");
        for (let render = 0; render < 20; render++) {
            expect(model.pick("ciFailed", "ciFailed|ci:/work/app:12")).toBe(first);
        }
        expect(calls).toHaveLength(1);
        expect(state.writes).toHaveLength(1);
    });

    it("draws a new one for another sentence, and again once the visit is over, even for the same event", () => {
        const { deps } = metaFixture();
        const model = fresh({ ...deps, random: seeded(3) });
        const a = model.pick("ciFailed", "ciFailed|ci:/work/app:12");
        const b = model.pick("ready", "ready|ready:/work/app:14");
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(VisitPhrasings.ready);
        model.rest();
        const again = model.pick("ciFailed", "ciFailed|ci:/work/app:12");
        expect(again).not.toBe(a);
    });
});

describe("the same sentence does not come back within a few visits (FR-BOSS-009, AC82)", () => {
    it("holds for every reason, over a long run of visits", () => {
        for (const reason of VisitReasons) {
            const size = VisitPhrasings[reason];
            for (const seed of [1, 2, 3, 4, 5]) {
                const { deps } = metaFixture();
                const model = fresh({ ...deps, random: seeded(seed) });
                const said: number[] = [];
                for (let visit = 0; visit < 80; visit++) {
                    const index = model.pick(reason, `${reason}|key`);
                    expect(said.slice(-windowOf(size)), `${reason}, seed ${seed}, visit ${visit}`).not.toContain(index);
                    said.push(index);
                    model.rest();
                }
            }
        }
    });

    it("holds after a restart: what was said last is read back from the client's meta", () => {
        const { state, deps } = metaFixture();
        const said: number[] = [];
        let model = fresh({ ...deps, random: seeded(11) });
        for (let visit = 0; visit < 30; visit++) {
            if (visit % 3 === 0) {
                model = fresh({ ...deps, random: seeded(100 + visit) });
            }
            const index = model.pick("ready", "ready|key");
            expect(said.slice(-windowOf(VisitPhrasings.ready)), `visit ${visit}`).not.toContain(index);
            said.push(index);
            model.rest();
        }
        expect(decodeWording(state.text).ready).toEqual(said.slice(-windowOf(VisitPhrasings.ready)));
    });

    it("holds across windows: what another window said since is read before drawing", () => {
        const { state, deps } = metaFixture();
        const model = fresh({ ...deps, random: seeded(5) });
        for (let visit = 0; visit < 40; visit++) {
            state.now += WriteEchoMs + 1;
            state.text = encodeWording({ usage: [0, 1] });
            const index = model.pick("usage", `usage|${visit}`);
            expect([0, 1], `visit ${visit}`).not.toContain(index);
            model.rest();
        }
    });

    it("does not read an older meta over its own write that has not come back, until it is given up", () => {
        const { state, deps } = metaFixture();
        state.lag = true;
        const model = fresh({ ...deps, random: seeded(9) });
        state.text = encodeWording({ download: [0] });
        const first = model.pick("download", "download|a");
        expect(first).not.toBe(0);
        model.rest();
        const second = model.pick("download", "download|b");
        expect(second).not.toBe(first);
        expect(second).not.toBe(0);
        model.rest();
        state.now += WriteEchoMs + 1;
        state.text = encodeWording({ download: [2, 3] });
        const third = model.pick("download", "download|c");
        expect([2, 3]).not.toContain(third);
    });
});

describe("a meta that fails costs a repeated sentence, never the line (FR-BOSS-009, AC82)", () => {
    it("draws on when the meta cannot be read or written, and starts afresh on a corrupt one", () => {
        const model = fresh({
            read: () => {
                throw new Error("no meta");
            },
            write: () => {
                throw new Error("no meta");
            },
            random: seeded(2),
        });
        const index = model.pick("other", "other|x");
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(VisitPhrasings.other);
        const { deps } = metaFixture();
        const corrupt = fresh({ ...deps, read: () => "{{{", random: seeded(2) });
        expect(corrupt.pick("other", "other|x")).toBeLessThan(VisitPhrasings.other);
    });
});

describe("the live meta (FR-BOSS-009, AC82)", () => {
    it("is the client's, under its own key, read and written like the kind colleague's", () => {
        BrokkVisitWords.resetInstance();
        globalStore.set(Sources.client, { meta: { [WordsMetaKey]: encodeWording({ ready: [0, 1] }) } });
        const model = BrokkVisitWords.getInstance();
        const index = model.pick("ready", "ready|a");
        expect([0, 1]).not.toContain(index);
        expect(Sources.setMeta).toHaveBeenCalledTimes(1);
        const [, request] = Sources.setMeta.mock.calls[0];
        expect(request.oref).toBe("client:client-1");
        expect(Object.keys(request.meta)).toEqual([WordsMetaKey]);
        expect(WordsMetaKey).not.toBe("moltenterm:brokkcolleague");
        expect(decodeWording(request.meta[WordsMetaKey]).ready).toEqual(
            [0, 1, index].slice(-windowOf(VisitPhrasings.ready))
        );
    });

    it("writes nothing before the client is known", () => {
        Sources.clientId = null;
        const model = BrokkVisitWords.getInstance();
        expect(model.pick("ready", "ready|a")).toBeGreaterThanOrEqual(0);
        expect(Sources.setMeta).not.toHaveBeenCalled();
    });
});
