// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// FR-REV-034 AC9 (#2174): the filter is kept per view, in the tab's meta. It is written once, when the panel first
// opens there; after that only the developer's clicks change it.

import { globalStore } from "@/app/store/jotaiStore";
import type { PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScopeMetaKey } from "./reviews-owners-model";
import { ViewScope } from "./reviews-owners-store";

const m = vi.hoisted(() => ({
    metas: new Map<string, unknown>(),
    writes: [] as { oref: string; meta: Record<string, unknown> }[],
    failWrites: false,
}));

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    const atoms = new Map<string, PrimitiveAtom<unknown>>();
    return {
        atoms: { staticTabId: atom("t1") },
        getTabMetaKeyAtom: (tabId: string) => {
            if (!atoms.has(tabId)) {
                atoms.set(tabId, atom(m.metas.get(tabId)));
            }
            return atoms.get(tabId);
        },
        tabMetaAtoms: atoms,
    };
});
vi.mock("@/app/store/wos", () => ({ makeORef: (type: string, id: string) => `${type}:${id}` }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetMetaCommand: (_client: unknown, data: { oref: string; meta: Record<string, unknown> }) => {
            m.writes.push(data);
            return m.failWrites ? Promise.reject(new Error("no backend")) : Promise.resolve();
        },
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

async function metaAtom(tabId: string): Promise<PrimitiveAtom<unknown>> {
    const global = await import("@/app/store/global");
    return global.getTabMetaKeyAtom(tabId, ScopeMetaKey as never) as unknown as PrimitiveAtom<unknown>;
}

describe("the view's filter", () => {
    beforeEach(async () => {
        ViewScope.resetInstance();
        m.metas.clear();
        m.writes.length = 0;
        m.failWrites = false;
        const global = await import("@/app/store/global");
        (global as unknown as { tabMetaAtoms: Map<string, unknown> }).tabMetaAtoms.clear();
    });

    it("is unknown until the panel first opens in the view", async () => {
        const store = ViewScope.getInstance();
        expect(globalStore.get(store.scopeAtom("t1"))).toBeNull();
    });

    it("opens on the agents already in the view, written on the tab", async () => {
        const store = ViewScope.getInstance();
        store.ensure("t1", ["Flore", "Hugo"]);
        expect(m.writes).toEqual([
            { oref: "tab:t1", meta: { [ScopeMetaKey]: { agents: ["Flore", "Hugo"], ignored: [] } } },
        ]);
        expect(globalStore.get(store.scopeAtom("t1"))).toEqual({ agents: ["Flore", "Hugo"], ignored: [] });
    });

    it("opens with no filter in a view without an agent, and keeps that: a later agent is proposed", () => {
        const store = ViewScope.getInstance();
        store.ensure("t1", []);
        expect(globalStore.get(store.scopeAtom("t1"))).toEqual({ agents: [], ignored: [] });
    });

    it("is written once: a view that holds one keeps it whoever is there now", async () => {
        const store = ViewScope.getInstance();
        m.metas.set("t2", { agents: ["Flore"], ignored: ["Marc"] });
        store.ensure("t2", ["Jérôme", "Zoé"]);
        store.ensure("t1", ["Flore"]);
        store.ensure("t1", ["Hugo"]);
        expect(m.writes.map((w) => w.oref)).toEqual(["tab:t1"]);
        expect(globalStore.get(store.scopeAtom("t2"))).toEqual({ agents: ["Flore"], ignored: ["Marc"] });
        expect(globalStore.get(store.scopeAtom("t1"))).toEqual({ agents: ["Flore"], ignored: [] });
    });

    it("is kept per view", async () => {
        const store = ViewScope.getInstance();
        store.ensure("t1", ["Flore"]);
        store.ensure("t2", ["Jérôme"]);
        expect(globalStore.get(store.scopeAtom("t1")).agents).toEqual(["Flore"]);
        expect(globalStore.get(store.scopeAtom("t2")).agents).toEqual(["Jérôme"]);
    });

    it("shows a write at once and follows the tab's meta when it changes from another page", async () => {
        const store = ViewScope.getInstance();
        store.write("t1", { agents: ["Flore"], ignored: ["Marc"] });
        expect(globalStore.get(store.scopeAtom("t1"))).toEqual({ agents: ["Flore"], ignored: ["Marc"] });
        globalStore.set(await metaAtom("t1"), { agents: ["Léa"], ignored: [] });
        expect(globalStore.get(store.scopeAtom("t1"))).toEqual({ agents: ["Léa"], ignored: [] });
    });

    it("keeps a write that failed for this page", () => {
        m.failWrites = true;
        const store = ViewScope.getInstance();
        store.write("t1", { agents: ["Flore"], ignored: [] });
        expect(globalStore.get(store.scopeAtom("t1"))).toEqual({ agents: ["Flore"], ignored: [] });
    });

    it("tells once that it just opened on agents, for the page to select their project", () => {
        const store = ViewScope.getInstance();
        store.ensure("t1", ["Flore"]);
        store.ensure("t2", []);
        expect(store.takeFresh("t1")).toBe(true);
        expect(store.takeFresh("t1")).toBe(false);
        expect(store.takeFresh("t2")).toBe(false);
    });

    it("writes nothing for a page without a view", () => {
        const store = ViewScope.getInstance();
        store.write("", { agents: ["Flore"], ignored: [] });
        store.ensure("", ["Flore"]);
        expect(m.writes).toEqual([]);
    });
});
