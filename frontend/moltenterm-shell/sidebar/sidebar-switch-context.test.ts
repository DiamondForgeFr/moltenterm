// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    list: [] as { workspaceid: string }[],
    workspaces: {} as Record<string, { oid: string; meta?: Record<string, any> }>,
    active: { oid: "a", meta: {} } as { oid: string; meta?: Record<string, any> },
    contexts: [] as { id: string }[],
    listCalls: 0,
    getCalls: [] as string[],
    // Asked, not yet answered: how many calls for a workspace were in the air together.
    inFlight: 0,
    mostInFlight: 0,
    onEvent: null as () => void,
}));

vi.mock("@/app/store/global", () => ({
    atoms: { workspace: {} },
    getApi: () => ({}),
    globalStore: { get: () => h.active },
}));
vi.mock("@/app/store/jotaiStore", () => ({ globalStore: { get: () => ({}) } }));
vi.mock("@/app/store/wos", () => ({
    getWaveObjectAtom: (oref: string) => ({ oref }),
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
}));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: (sub: { handler: () => void }) => {
        h.onEvent = sub.handler;
        return () => {};
    },
}));
vi.mock("@/app/store/services", () => ({
    WorkspaceService: {
        ListWorkspaces: async () => {
            h.listCalls++;
            return h.list;
        },
        GetWorkspace: async (id: string) => {
            h.getCalls.push(id);
            h.inFlight++;
            h.mostInFlight = Math.max(h.mostInFlight, h.inFlight);
            await Promise.resolve();
            await Promise.resolve();
            h.inFlight--;
            return h.workspaces[id] ?? null;
        },
    },
}));
vi.mock("../contexts/context-store", () => ({
    getContexts: () => h.contexts,
    getWindowContextId: () => {
        const id = h.active.meta?.["molten:context"];
        return h.contexts.some((c) => c.id === id) ? id : h.contexts[0].id;
    },
}));

import { resetWorkspaceSourcesForTest } from "../workspace-sources";
import { windowContextWorkspaceIds } from "./sidebar-switch";

function setUp(entries: Record<string, string>, active: string) {
    resetWorkspaceSourcesForTest();
    h.listCalls = 0;
    h.getCalls = [];
    h.inFlight = 0;
    h.mostInFlight = 0;
    h.contexts = [{ id: "one" }, { id: "two" }];
    h.list = Object.keys(entries).map((workspaceid) => ({ workspaceid }));
    h.workspaces = {};
    for (const [id, context] of Object.entries(entries)) {
        h.workspaces[id] = { oid: id, meta: context ? { "molten:context": context } : {} };
    }
    h.active = h.workspaces[active] ?? { oid: active, meta: {} };
}

// ⌥1…⌥9 count the workspaces the bottom switcher lists: the window's context's (FR-SHELL-158).
describe("the workspaces the switch keys count", () => {
    beforeEach(() => setUp({}, "a"));

    it("keeps the window's context, in the rail's order", async () => {
        setUp({ a: "one", b: "two", c: "one", d: "two", e: "" }, "c");
        expect(await windowContextWorkspaceIds()).toEqual(["a", "c", "e"]);
        setUp({ a: "one", b: "two", c: "one", d: "two", e: "" }, "d");
        expect(await windowContextWorkspaceIds()).toEqual(["b", "d"]);
    });

    it("puts an unsaved workspace on screen first, as the dots do", async () => {
        setUp({ a: "one", b: "two" }, "a");
        h.active = { oid: "tmp", meta: {} };
        expect(await windowContextWorkspaceIds()).toEqual(["tmp", "a"]);
    });

    it("leaves out a workspace that cannot be read", async () => {
        setUp({ a: "one", b: "one" }, "a");
        delete h.workspaces.b;
        expect(await windowContextWorkspaceIds()).toEqual(["a"]);
    });

    // #2476: a key press asks for every workspace at once, and for none when the page already read them.
    it("asks for the workspaces together, never one after the other", async () => {
        setUp({ a: "one", b: "two", c: "one", d: "two", e: "one" }, "a");
        await windowContextWorkspaceIds();
        expect(h.getCalls.slice().sort()).toEqual(["a", "b", "c", "d", "e"]);
        expect(h.mostInFlight).toBe(5);
    });

    it("reads nothing again while no workspace changed, and again once one did", async () => {
        setUp({ a: "one", b: "two", c: "one" }, "a");
        await windowContextWorkspaceIds();
        await windowContextWorkspaceIds();
        await windowContextWorkspaceIds();
        expect(h.listCalls).toBe(1);
        expect(h.getCalls.length).toBe(3);
        h.workspaces.b = { oid: "b", meta: { "molten:context": "one" } };
        h.onEvent();
        expect(await windowContextWorkspaceIds()).toEqual(["a", "b", "c"]);
        expect(h.listCalls).toBe(2);
    });
});
