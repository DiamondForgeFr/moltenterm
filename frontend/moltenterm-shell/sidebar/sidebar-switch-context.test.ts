// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    list: [] as { workspaceid: string }[],
    workspaces: {} as Record<string, { oid: string; meta?: Record<string, any> }>,
    active: { oid: "a", meta: {} } as { oid: string; meta?: Record<string, any> },
    contexts: [] as { id: string }[],
}));

vi.mock("@/app/store/global", () => ({
    atoms: { workspace: {} },
    getApi: () => ({}),
    globalStore: { get: () => h.active },
}));
vi.mock("@/app/store/services", () => ({
    WorkspaceService: {
        ListWorkspaces: async () => h.list,
        GetWorkspace: async (id: string) => h.workspaces[id] ?? null,
    },
}));
vi.mock("../contexts/context-store", () => ({
    getContexts: () => h.contexts,
    getWindowContextId: () => {
        const id = h.active.meta?.["molten:context"];
        return h.contexts.some((c) => c.id === id) ? id : h.contexts[0].id;
    },
}));

import { windowContextWorkspaceIds } from "./sidebar-switch";

function setUp(entries: Record<string, string>, active: string) {
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
});
