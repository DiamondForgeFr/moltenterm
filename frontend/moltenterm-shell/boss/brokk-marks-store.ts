// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The page's side of Brokk's shared marks (FR-BOSS-009, AC106, #2391, rules in brokk-marks.ts): it reads them from the
// client's meta, which every page holds and wavesrv broadcasts on each change, and writes them back. A value this page
// wrote is read as written until the meta echoes it, so a gesture shows at once; a write whose echo does not come is
// dropped after a while, so that a failed write cannot hide what the other pages wrote.
//
// Two pages can write the same key at once, each from what it read: the meta keeps the last write, and the other one's
// mark would be lost. A change is therefore written as a function of what the meta holds, and when another page's write
// comes in before this page's echo, the change is applied again to it, once.
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
    // Sends what was written before the client was known, once it is.
    flush?: () => void;
};

// A change of one key: the value to write, from the value the meta holds.
export type MarkChange = (raw: unknown) => unknown;

function liveClientAtom(): Atom<Client> {
    return ClientModel.getInstance().clientAtom;
}

// What was written before the client's id was known: sent as soon as it is.
let queued: MarksMeta = null;

function liveSend(meta: MarksMeta): void {
    const clientId = ClientModel.getInstance().clientId;
    if (clientId == null) {
        queued = { ...(queued ?? {}), ...meta };
        return;
    }
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, { oref: makeORef("client", clientId), meta: meta as MetaType })
    );
}

const LiveDeps: MarksDeps = {
    now: () => Date.now(),
    read: () => {
        const clientAtom = liveClientAtom();
        const client = clientAtom != null ? globalStore.get(clientAtom) : null;
        return client == null ? null : ((client.meta ?? {}) as MarksMeta);
    },
    write: liveSend,
    subscribe: (listener) => {
        const clientAtom = liveClientAtom();
        return clientAtom != null ? globalStore.sub(clientAtom, listener) : () => {};
    },
    flush: () => {
        if (queued == null || ClientModel.getInstance().clientId == null) {
            return;
        }
        const meta = queued;
        queued = null;
        liveSend(meta);
    },
};

// The page writes what every page computes the same way (his mood, the plan usage seen): only the page the developer
// is in, so that ten workspaces do not write it ten times. A page nobody looks at only reads it.
export function pageWrites(doc: Pick<Document, "visibilityState" | "hasFocus"> = globalThis.document): boolean {
    return doc != null && doc.visibilityState === "visible" && doc.hasFocus?.() === true;
}

function sameValue(a: unknown, b: unknown): boolean {
    return a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

type Pending = {
    value: unknown;
    at: number;
    // The meta's value it was computed from, and how to compute it again; retried once.
    base: unknown;
    change: MarkChange;
    retried: boolean;
};

export class BrokkMarks {
    private static instance: BrokkMarks = null;

    // The marks as this page reads them: the meta's, with what this page wrote and the meta has not echoed yet.
    metaAtom = atom({}) as PrimitiveAtom<MarksMeta>;
    // The last moment the developer opened his group, anywhere; 0 before anything is known.
    heardAtAtom: Atom<number>;

    deps: MarksDeps = LiveDeps;
    private pending = new Map<string, Pending>();
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
        this.deps = { ...LiveDeps, flush: undefined, ...deps };
        this.pending.clear();
        this.refresh();
        if (this.stopListening != null) {
            this.stopListening();
            this.stopListening = this.deps.subscribe(() => this.refresh());
        }
    }

    // Listens to the meta while a host is on screen; returns the stop. Each reading (refresh) sets the first moment he
    // is heard when the loaded meta has none, and sends what was written before the client was known.
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

    // Writes these values as they are: the last write wins.
    write(meta: MarksMeta): void {
        const changes: Record<string, MarkChange> = {};
        for (const [key, value] of Object.entries(meta)) {
            changes[key] = () => value;
        }
        this.update(changes);
    }

    // Writes each key as a change of what the meta holds: applied again to another page's write that comes first.
    update(changes: Record<string, MarkChange>): void {
        this.refresh();
        const now = this.deps.now();
        const current = globalStore.get(this.metaAtom);
        const meta: MarksMeta = {};
        for (const [key, change] of Object.entries(changes)) {
            const base = current[key];
            const value = change(base);
            meta[key] = value;
            this.pending.set(key, { value, at: now, base, change, retried: false });
        }
        this.refresh();
        this.send(meta);
    }

    private send(meta: MarksMeta): void {
        try {
            this.deps.write(meta);
        } catch {
            // A write that fails leaves the marks in this page until the echo times out.
        }
    }

    // Reads the meta again; the atom changes only when a value did.
    refresh(): void {
        this.deps.flush?.();
        const loaded = this.deps.read();
        const meta = loaded ?? {};
        const now = this.deps.now();
        const resend: MarksMeta = {};
        // Only once the meta is loaded: an unread meta has no moment yet, and must not overwrite the one it holds.
        if (loaded != null && loaded[HeardMetaKey] == null && !this.pending.has(HeardMetaKey)) {
            this.pending.set(HeardMetaKey, {
                value: now,
                at: now,
                base: undefined,
                change: (raw) => Math.max(readHeard(raw), now),
                retried: false,
            });
            resend[HeardMetaKey] = now;
        }
        const next: MarksMeta = {};
        for (const key of MarksMetaKeys) {
            const held = this.pending.get(key);
            if (held != null && (sameValue(meta[key], held.value) || now - held.at >= MarksWriteEchoMs)) {
                this.pending.delete(key);
            } else if (held != null && loaded != null && !held.retried && !sameValue(meta[key], held.base)) {
                // Another page wrote this key before this page's echo came: the change goes on top of its write.
                const value = held.change(meta[key]);
                this.pending.set(key, { ...held, value, base: meta[key], retried: true });
                resend[key] = value;
            }
            const kept = this.pending.get(key);
            const value = kept != null ? kept.value : meta[key];
            if (value != null) {
                next[key] = value;
            }
        }
        const current = globalStore.get(this.metaAtom);
        const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
        if (![...keys].every((key) => sameValue(current[key], next[key]))) {
            globalStore.set(this.metaAtom, next);
        }
        if (Object.keys(resend).length > 0) {
            this.send(resend);
        }
    }
}
