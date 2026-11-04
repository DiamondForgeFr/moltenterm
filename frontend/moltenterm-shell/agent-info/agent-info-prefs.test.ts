// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/global", async () => {
    const { fakeBlocks } = await import("./block-meta-fake");
    return { atoms: {}, getBlockMetaKeyAtom: fakeBlocks.getBlockMetaKeyAtom };
});
vi.mock("@/app/store/wshclientapi", async () => ({ RpcApi: (await import("./block-meta-fake")).fakeBlocks.rpc }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: async () => ({ entries: [] }) } }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));

import type { SubagentRow } from "./agent-info-model";
import {
    AgentInfoModel,
    AgentTreeMetaKey,
    LegacySeenStorageKey,
    LegacyTreesStorageKey,
    migrateLegacy,
    resetMigration,
    SeenFailuresMetaKey,
    SeenMaxIds,
} from "./agent-info-store";
import { fakeBlocks as fake } from "./block-meta-fake";

function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
        get length() {
            return data.size;
        },
        key: (i: number) => [...data.keys()][i] ?? null,
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
        data,
    };
}

// A new page: its own model, which only knows what the blocks hold.
function newPage(): AgentInfoModel {
    AgentInfoModel.resetInstance();
    resetMigration();
    return AgentInfoModel.getInstance();
}

async function flush() {
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
    }
}

function failed(id: string, ended: number): SubagentRow {
    return { id, state: "error", started: 1, ended } as SubagentRow;
}

describe("agent trees and seen failures, on the terminal's block (#1763)", () => {
    beforeEach(() => {
        fake.reset();
        fake.set("b1", { view: "term" });
        fake.set("b2", { view: "term" });
        vi.stubGlobal("localStorage", memoryStorage());
    });

    afterEach(() => {
        AgentInfoModel.resetInstance();
        resetMigration();
        vi.unstubAllGlobals();
    });

    it("keeps an opened tree and a shut section for a new page, and after a restart", async () => {
        const model = newPage();
        model.toggleTree("b1");
        model.toggleSection("b1", "links");
        expect(globalStore.get(model.treeAtom("b1"))).toEqual({ open: true, shut: { links: true } });
        await flush();
        expect(fake.writes.at(-1)).toEqual({
            blockId: "b1",
            meta: { [AgentTreeMetaKey]: { open: true, shut: { links: true } } },
        });
        const other = newPage();
        expect(globalStore.get(other.treeAtom("b1"))).toEqual({ open: true, shut: { links: true } });
        expect(globalStore.get(other.treeAtom("b2"))).toEqual({});
        // A restart: the page's storage is gone, the block keeps its meta.
        vi.stubGlobal("localStorage", memoryStorage());
        const restarted = newPage();
        expect(globalStore.get(restarted.treeAtom("b1")).open).toBe(true);
    });

    it("shows another page's change live", async () => {
        const model = newPage();
        const tree = model.treeAtom("b1");
        expect(globalStore.get(tree)).toEqual({});
        fake.set("b1", { [AgentTreeMetaKey]: { open: true } });
        expect(globalStore.get(tree).open).toBe(true);
        // This page's own write, then another page's newer one: the newer one shows.
        model.toggleTree("b1");
        await flush();
        expect(globalStore.get(tree).open).toBe(false);
        fake.set("b1", { [AgentTreeMetaKey]: { open: true, shut: { subs: true } } });
        expect(globalStore.get(tree)).toEqual({ open: true, shut: { subs: true } });
        fake.set("b1", { [SeenFailuresMetaKey]: { x: "1:5" } });
        expect(globalStore.get(model.seenAtom("b1"))).toEqual({ x: "1:5" });
    });

    it("keeps the change on the page when it cannot be saved", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        fake.fail = true;
        const model = newPage();
        model.toggleTree("b1");
        model.markSubSeen("b1", failed("x", 5));
        await flush();
        expect(globalStore.get(model.treeAtom("b1")).open).toBe(true);
        expect(globalStore.get(model.seenAtom("b1"))).toEqual({ x: "1:5" });
        expect(log).toHaveBeenCalled();
        log.mockRestore();
    });

    it("keeps a seen failure for a new page, per terminal, the latest ids only", async () => {
        const model = newPage();
        for (let i = 0; i < SeenMaxIds + 5; i++) {
            model.markSubSeen("b1", failed(`s${i}`, 5));
            await flush();
        }
        model.markSubSeen("b2", failed("other", 7));
        await flush();
        const other = newPage();
        const seen = globalStore.get(other.seenAtom("b1"));
        expect(Object.keys(seen)).toHaveLength(SeenMaxIds);
        expect(seen[`s${SeenMaxIds + 4}`]).toBe("1:5");
        expect(seen.s0).toBeUndefined();
        expect(globalStore.get(other.seenAtom("b2"))).toEqual({ other: "1:7" });
    });

    it("moves the old localStorage values onto the terminals once, never over a value they hold", async () => {
        fake.set("b2", { [AgentTreeMetaKey]: { open: false, shut: { subs: true } } });
        const storage = memoryStorage({
            [LegacyTreesStorageKey]: JSON.stringify({ b1: { open: true }, b2: { open: true } }),
            [LegacySeenStorageKey]: JSON.stringify({ b1: { x: "1:5" } }),
        });
        vi.stubGlobal("localStorage", storage);
        await migrateLegacy();
        const model = newPage();
        await flush();
        expect(globalStore.get(model.treeAtom("b1")).open).toBe(true);
        expect(globalStore.get(model.seenAtom("b1"))).toEqual({ x: "1:5" });
        expect(globalStore.get(model.treeAtom("b2"))).toEqual({ open: false, shut: { subs: true } });
        expect(storage.data.size).toBe(0);
        // Moved once: nothing is left to move.
        fake.writes = [];
        await migrateLegacy();
        expect(fake.writes).toEqual([]);
    });

    it("keeps the old values for the next start when a terminal cannot be read", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const storage = memoryStorage({ [LegacyTreesStorageKey]: JSON.stringify({ gone: { open: true } }) });
        vi.stubGlobal("localStorage", storage);
        await migrateLegacy();
        expect(fake.writes).toEqual([]);
        expect(storage.data.has(LegacyTreesStorageKey)).toBe(true);
        log.mockRestore();
    });
});
