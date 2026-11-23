// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import type { PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    store: null as any,
    workspaceAtom: null as PrimitiveAtom<unknown>,
    clientAtom: null as PrimitiveAtom<unknown>,
    agentsAtom: null as PrimitiveAtom<unknown>,
    workspaces: {} as Record<string, any>,
    onEvent: null as () => void,
    listCalls: 0,
    getCalls: 0,
}));

vi.mock("@/app/store/jotaiStore", async () => {
    h.store = (await import("jotai")).createStore();
    return { globalStore: h.store };
});
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    h.workspaceAtom = atom(null) as PrimitiveAtom<unknown>;
    return { atoms: { workspace: h.workspaceAtom } };
});
vi.mock("@/app/store/client-model", async () => {
    const { atom } = await import("jotai");
    h.clientAtom = atom({ meta: {} }) as PrimitiveAtom<unknown>;
    return { ClientModel: { getInstance: () => ({ clientAtom: h.clientAtom }) } };
});
vi.mock("@/app/store/services", () => ({
    WorkspaceService: {
        ListWorkspaces: async () => {
            h.listCalls++;
            return Object.keys(h.workspaces).map((workspaceid) => ({ workspaceid }));
        },
        GetWorkspace: async (id: string) => {
            h.getCalls++;
            return h.workspaces[id] ?? null;
        },
    },
}));
vi.mock("@/app/store/wos", async () => {
    const { atom } = await import("jotai");
    return {
        getWaveObjectAtom: () => atom(null),
        makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    };
});
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: (sub: { handler: () => void }) => {
        h.onEvent = sub.handler;
        return () => {};
    },
}));
vi.mock("../agent-state-store", async () => {
    const { atom } = await import("jotai");
    h.agentsAtom = atom({ states: {}, versions: {} }) as PrimitiveAtom<unknown>;
    return { AgentStates: { getInstance: () => ({ dataAtom: h.agentsAtom }) } };
});

import { resetWorkspaceSourcesForTest, subscribeWorkspaceSources } from "../workspace-sources";
import { ContextScope } from "./context-scope";

function workspace(oid: string, context: string, dir = ""): any {
    return { oid, meta: { ...(context ? { "molten:context": context } : {}), ...(dir ? { "molten:project": dir } : {}) } };
}

// Waits for what the store reads asynchronously: it polls, with a deadline that only bounds a failing run.
const until = (check: () => void) => vi.waitFor(check, { timeout: 30000, interval: 5 });

const agents = {
    states: {
        b1: { blockid: "b1", workspaceid: "w1", state: "working", version: 1 },
        b2: { blockid: "b2", workspaceid: "w2", state: "waiting", version: 1 },
    },
    versions: { b1: 1, b2: 1 },
};

// FR-BOSS-009 (#2476): in a window Brokk reads the agents of that window's context only.
describe("Brokk's scope in a window", () => {
    beforeEach(() => {
        ContextScope.resetInstance();
        resetWorkspaceSourcesForTest();
        h.listCalls = 0;
        h.getCalls = 0;
        h.workspaces = { w1: workspace("w1", ""), w2: workspace("w2", "two") };
        h.store.set(h.clientAtom, { meta: { "molten:contexts": [{ id: "one" }, { id: "two", name: "Two" }] } });
        h.store.set(h.workspaceAtom, h.workspaces.w1);
        h.store.set(h.agentsAtom, agents);
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("hides nothing until the window has read where the workspaces are", () => {
        const scope = ContextScope.getInstance();
        expect(h.store.get(scope.scopedAgentsAtom)).toBe(agents);
    });

    it("reads the agents of the context of the workspace on screen, and follows a switch of context", async () => {
        const scope = ContextScope.getInstance();
        scope.start();
        await until(() => expect(Object.keys(h.store.get(scope.scopedAgentsAtom).states)).toEqual(["b1"]));
        h.store.set(h.workspaceAtom, h.workspaces.w2);
        expect(Object.keys(h.store.get(scope.scopedAgentsAtom).states)).toEqual(["b2"]);
    });

    it("reads the workspaces again when one changes, so a workspace moved to another context follows", async () => {
        const scope = ContextScope.getInstance();
        scope.start();
        await until(() => expect(Object.keys(h.store.get(scope.scopedAgentsAtom).states)).toEqual(["b1"]));
        h.workspaces.w2 = workspace("w2", "");
        h.onEvent();
        await until(() =>
            expect(Object.keys(h.store.get(scope.scopedAgentsAtom).states).sort()).toEqual(["b1", "b2"])
        );
    });

    // The sidebar of the page reads the same workspaces: Brokk's scope follows that read instead of making its own.
    it("shares one read of the workspaces with the sidebar, at the start and at each change", async () => {
        const seen: number[] = [];
        subscribeWorkspaceSources((sources) => seen.push(sources.length));
        const scope = ContextScope.getInstance();
        scope.start();
        await until(() => expect(Object.keys(h.store.get(scope.scopedAgentsAtom).states)).toEqual(["b1"]));
        expect(h.listCalls).toBe(1);
        expect(h.getCalls).toBe(2);

        h.workspaces.w2 = workspace("w2", "");
        h.onEvent();
        await until(() =>
            expect(Object.keys(h.store.get(scope.scopedAgentsAtom).states).sort()).toEqual(["b1", "b2"])
        );
        expect(seen.length).toBe(2);
        expect(h.listCalls).toBe(2);
        expect(h.getCalls).toBe(4);
    });

    it("starts once", async () => {
        const scope = ContextScope.getInstance();
        scope.start();
        const handler = h.onEvent;
        scope.start();
        expect(h.onEvent).toBe(handler);
    });
});
