// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The page's side of Brokk's shared marks (FR-BOSS-009, AC106, #2391, rules in brokk-marks.ts): it reads them from the
// client's meta, which every page holds and wavesrv broadcasts on each change, and writes them back. A value this page
// wrote is read as written until the meta echoes it, so a gesture shows at once; a write whose echo does not come is
// dropped after a while, so that a failed write cannot hide what the other pages wrote.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, Atom, PrimitiveAtom } from "jotai";
import { HeardMetaKey, MarksMeta, MarksMetaKeys, readHeard } from "./brokk-marks";

export const MarksWriteEchoMs = 30000;

export type MarksDeps = {
    now: () => number;
    // The client's meta as this page holds it now, null before it is loaded.
    read: () => MarksMeta;
    write: (meta: MarksMeta) => void;
    // Calls the listener when the client's meta changed; returns the stop.
    subscribe: (listener: () => void) => () => void;
};

function liveClientAtom(): Atom<Client> {
    return ClientModel.getInstance().clientAtom;
}

const LiveDeps: MarksDeps = {
    now: () => Date.now(),
    read: () => {
        const clientAtom = liveClientAtom();
        const client = clientAtom != null ? globalStore.get(clientAtom) : null;
        return client == null ? null : ((client.meta ?? {}) as MarksMeta);
    },
    write: (meta) => {
        const clientId = ClientModel.getInstance().clientId;
        if (clientId == null) {
            return;
        }
        fireAndForget(() =>
            RpcApi.SetMetaCommand(TabRpcClient, { oref: makeORef("client", clientId), meta: meta as MetaType })
        );
    },
    subscribe: (listener) => {
        const clientAtom = liveClientAtom();
        return clientAtom != null ? globalStore.sub(clientAtom, listener) : () => {};
    },
};

function sameValue(a: unknown, b: unknown): boolean {
    return a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export class BrokkMarks {
    private static instance: BrokkMarks = null;

    // The marks as this page reads them: the meta's, with what this page wrote and the meta has not echoed yet.
    metaAtom = atom({}) as PrimitiveAtom<MarksMeta>;
    // The last moment the developer opened his group, anywhere; 0 before anything is known.
    heardAtAtom: Atom<number>;

    deps: MarksDeps = LiveDeps;
    private pending = new Map<string, { value: unknown; at: number }>();
    private users = 0;
    private stopListening: () => void = null;

    private constructor() {
        this.heardAtAtom = atom((get) => readHeard(get(this.metaAtom)[HeardMetaKey]));
    }

    static getInstance(): BrokkMarks {
        if (BrokkMarks.instance == null) {
            BrokkMarks.instance = new BrokkMarks();
        }
        return BrokkMarks.instance;
    }

    static resetInstance(): void {
        BrokkMarks.instance?.stopListening?.();
        BrokkMarks.instance = null;
    }

    // Tests give a meta of their own.
    useDeps(deps: Partial<MarksDeps>): void {
        this.deps = { ...LiveDeps, ...deps };
        this.pending.clear();
        this.refresh();
        if (this.stopListening != null) {
            this.stopListening();
            this.stopListening = this.deps.subscribe(() => this.refresh());
        }
    }

    // Listens to the meta while a host is on screen; returns the stop. The first moment he is heard is set once, at the
    // first start on this computer: what was there before is no news.
    start(): () => void {
        this.users++;
        if (this.stopListening == null) {
            this.stopListening = this.deps.subscribe(() => this.refresh());
        }
        this.refresh();
        let stopped = false;
        return () => {
            if (stopped) {
                return;
            }
            stopped = true;
            this.users--;
            if (this.users === 0 && this.stopListening != null) {
                this.stopListening();
                this.stopListening = null;
            }
        };
    }

    value(key: string): unknown {
        this.refresh();
        return globalStore.get(this.metaAtom)[key];
    }

    write(meta: MarksMeta): void {
        const now = this.deps.now();
        for (const [key, value] of Object.entries(meta)) {
            this.pending.set(key, { value, at: now });
        }
        this.refresh();
        try {
            this.deps.write(meta);
        } catch {
            // A write that fails leaves the marks in this page until the echo times out.
        }
    }

    // Reads the meta again; the atom changes only when a value did.
    refresh(): void {
        const loaded = this.deps.read();
        const meta = loaded ?? {};
        const now = this.deps.now();
        // Only once the meta is loaded: an unread meta has no moment yet, and must not overwrite the one it holds.
        if (loaded != null && loaded[HeardMetaKey] == null && !this.pending.has(HeardMetaKey)) {
            this.pending.set(HeardMetaKey, { value: now, at: now });
            try {
                this.deps.write({ [HeardMetaKey]: now });
            } catch {
                // This page reads its own moment until the echo times out.
            }
        }
        const next: MarksMeta = {};
        for (const key of MarksMetaKeys) {
            const held = this.pending.get(key);
            if (held != null && (sameValue(meta[key], held.value) || now - held.at >= MarksWriteEchoMs)) {
                this.pending.delete(key);
            }
            const kept = this.pending.get(key);
            const value = kept != null ? kept.value : meta[key];
            if (value != null) {
                next[key] = value;
            }
        }
        const current = globalStore.get(this.metaAtom);
        const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
        if ([...keys].every((key) => sameValue(current[key], next[key]))) {
            return;
        }
        globalStore.set(this.metaAtom, next);
    }
}
