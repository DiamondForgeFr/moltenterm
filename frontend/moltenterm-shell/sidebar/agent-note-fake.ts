// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// For tests (#2008): workspaces as wavesrv holds them. Any RpcApi call is recorded by name; a SetMetaCommand on a
// workspace lands in its meta, as a null removes a key, and every page reads the workspace live through the object
// store. A restart keeps them, as the database does. Wire it with vi.mock of @/app/store/wshclientapi (RpcApi) and
// @/util/fetchutil (the object store loads nothing), and hand it the object store with bind(): the store imports
// wshclientapi, so this module cannot import the store itself while that mock is being built.

import { globalStore } from "@/app/store/jotaiStore";

type ObjectStore = {
    makeORef: (otype: string, oid: string) => string;
    getWaveObjectAtom: (oref: string) => any;
    setObjectValue: (value: any) => void;
};

export type FakeCall = { name: string; oref?: string; meta?: Record<string, unknown> };

export type FakeWorkspaces = {
    calls: FakeCall[];
    fail: boolean;
    rpc: Record<string, (client: unknown, data?: any) => Promise<unknown>>;
    bind: (store: ObjectStore) => void;
    seed: (workspaceId: string, meta?: Record<string, unknown>) => void;
    meta: (workspaceId: string) => Record<string, unknown>;
    reset: () => void;
};

function workspaceIdOf(oref: string): string {
    return oref?.startsWith("workspace:") ? oref.slice("workspace:".length) : null;
}

export function makeFakeWorkspaces(): FakeWorkspaces {
    let store: ObjectStore = null;
    const fake: FakeWorkspaces = {
        calls: [],
        fail: false,
        rpc: new Proxy({} as FakeWorkspaces["rpc"], {
            get: (_target, name: string) => async (_client: unknown, data?: any) => {
                fake.calls.push({ name, oref: data?.oref, meta: data?.meta });
                if (name !== "SetMetaCommand") {
                    return null;
                }
                const id = workspaceIdOf(data?.oref);
                if (fake.fail || id == null) {
                    throw new Error(`cannot set meta on ${data?.oref}`);
                }
                const next = { ...fake.meta(id) };
                for (const [key, value] of Object.entries(data.meta ?? {})) {
                    if (value == null) {
                        delete next[key];
                    } else {
                        next[key] = value;
                    }
                }
                fake.seed(id, next);
                return null;
            },
        }),
        bind: (s) => {
            store = s;
        },
        seed: (workspaceId, meta = {}) => {
            globalStore.get(store.getWaveObjectAtom(store.makeORef("workspace", workspaceId)));
            store.setObjectValue({ otype: "workspace", oid: workspaceId, version: 1, meta });
        },
        meta: (workspaceId) => {
            const workspace = globalStore.get(store.getWaveObjectAtom(store.makeORef("workspace", workspaceId)));
            return (workspace as { meta?: Record<string, unknown> })?.meta ?? {};
        },
        reset: () => {
            fake.calls = [];
            fake.fail = false;
        },
    };
    return fake;
}

// One per test file: vi.mock factories and the test share it (await import of this module inside a factory).
export const fakeWorkspaces = makeFakeWorkspaces();
