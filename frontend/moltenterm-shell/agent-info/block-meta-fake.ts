// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// For tests (#1763): blocks' meta as wavesrv holds them. A SetMetaCommand lands in the block, and every page reads the
// block's meta live; a restart keeps them, as the database does. Wire it with vi.mock of @/app/store/global
// (getBlockMetaKeyAtom) and @/app/store/wshclientapi (RpcApi).

import { globalStore } from "@/app/store/jotaiStore";
import { atom, Atom, PrimitiveAtom } from "jotai";

export type FakeBlocks = {
    metaAtom: PrimitiveAtom<Record<string, Record<string, unknown>>>;
    writes: { blockId: string; meta: Record<string, unknown> }[];
    fail: boolean;
    getBlockMetaKeyAtom: (blockId: string, key: string) => Atom<unknown>;
    rpc: {
        SetMetaCommand: (client: unknown, data: { oref: string; meta: Record<string, unknown> }) => Promise<void>;
        GetMetaCommand: (client: unknown, data: { oref: string }) => Promise<Record<string, unknown>>;
    };
    set: (blockId: string, meta: Record<string, unknown>) => void;
    reset: () => void;
};

function blockIdOf(oref: string): string {
    return oref.startsWith("block:") ? oref.slice("block:".length) : null;
}

export function makeFakeBlocks(): FakeBlocks {
    const metaAtom = atom({}) as PrimitiveAtom<Record<string, Record<string, unknown>>>;
    const keyAtoms = new Map<string, Atom<unknown>>();
    const fake: FakeBlocks = {
        metaAtom,
        writes: [],
        fail: false,
        getBlockMetaKeyAtom: (blockId, key) => {
            const name = `${blockId}\n${key}`;
            if (!keyAtoms.has(name)) {
                keyAtoms.set(
                    name,
                    atom((get) => get(metaAtom)[blockId]?.[key])
                );
            }
            return keyAtoms.get(name);
        },
        set: (blockId, meta) => {
            const all = globalStore.get(metaAtom);
            globalStore.set(metaAtom, { ...all, [blockId]: { ...(all[blockId] ?? {}), ...meta } });
        },
        reset: () => {
            fake.writes = [];
            fake.fail = false;
            globalStore.set(metaAtom, {});
        },
        rpc: {
            SetMetaCommand: async (_client, data) => {
                const blockId = blockIdOf(data.oref);
                if (fake.fail || blockId == null || globalStore.get(metaAtom)[blockId] == null) {
                    throw new Error(`cannot set meta on ${data.oref}`);
                }
                fake.writes.push({ blockId, meta: data.meta });
                fake.set(blockId, data.meta);
            },
            GetMetaCommand: async (_client, data) => {
                const meta = globalStore.get(metaAtom)[blockIdOf(data.oref)];
                if (fake.fail || meta == null) {
                    throw new Error(`not found: ${data.oref}`);
                }
                return meta;
            },
        },
    };
    return fake;
}

// One per test file: vi.mock factories and the test share it (await import of this module inside a factory).
export const fakeBlocks = makeFakeBlocks();
