// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    created: [] as string[],
    assigned: [] as [string, string][],
    switched: [] as string[],
    opened: [] as string[],
    nextId: "made",
}));

vi.mock("@/app/store/global", () => ({
    getApi: () => ({
        openWorkspaceWindow: async (id: string) => {
            h.opened.push(id);
            return "opened";
        },
    }),
}));
vi.mock("@/app/store/services", () => ({
    WorkspaceService: {
        CreateWorkspace: async () => {
            h.created.push(h.nextId);
            return h.nextId;
        },
    },
}));
vi.mock("../sidebar/sidebar-switch", () => ({
    switchFromSidebar: (id: string) => h.switched.push(id),
}));
vi.mock("./context-store", () => ({
    assignWorkspaceToContext: async (workspaceId: string, contextId: string) => {
        h.assigned.push([workspaceId, contextId]);
    },
}));

import { chooseContext, openContextInNewWindow } from "./context-actions";
import { ContextRibbon, ContextWorkspace } from "./context-model";

function ws(id: string, contextId: string, extra: Partial<ContextWorkspace> = {}): ContextWorkspace {
    return { id, contextId, name: id, color: "#fff", saved: true, active: false, open: false, ...extra };
}

function ribbon(overrides: Partial<ContextRibbon>): ContextRibbon {
    return {
        context: { id: "df" },
        name: "DiamondForge",
        emblem: "briefcase",
        here: false,
        waiting: 0,
        workspaces: 1,
        landing: ws("b", "df"),
        hint: { kind: "workspaces", count: 1 },
        ...overrides,
    };
}

beforeEach(() => {
    h.created.length = 0;
    h.assigned.length = 0;
    h.switched.length = 0;
    h.opened.length = 0;
});

describe("choosing a ribbon", () => {
    it("lands the window on the workspace the ribbon's colour comes from", async () => {
        await chooseContext(ribbon({}));
        expect(h.switched).toEqual(["b"]);
        expect(h.created).toEqual([]);
    });

    it("does nothing on the ribbon of the window's own context", async () => {
        await chooseContext(ribbon({ here: true }));
        expect(h.switched).toEqual([]);
    });

    it("makes a workspace in a context that holds none, then lands on it", async () => {
        await chooseContext(ribbon({ landing: null, workspaces: 0 }));
        expect(h.created).toEqual(["made"]);
        expect(h.assigned).toEqual([["made", "df"]]);
        expect(h.switched).toEqual(["made"]);
    });
});

describe("opening a context in a new window", () => {
    it("opens the window on a workspace of the context no window shows", async () => {
        await openContextInNewWindow("df", [ws("a", "df", { open: true }), ws("b", "df"), ws("c", "other")], "");
        expect(h.opened).toEqual(["b"]);
        expect(h.created).toEqual([]);
    });

    it("prefers the one the context last showed", async () => {
        await openContextInNewWindow("df", [ws("a", "df"), ws("b", "df")], "b");
        expect(h.opened).toEqual(["b"]);
    });

    it("makes a workspace in the context when every one is shown, and opens the window on it", async () => {
        await openContextInNewWindow("df", [ws("a", "df", { open: true })], "a");
        expect(h.created).toEqual(["made"]);
        expect(h.assigned).toEqual([["made", "df"]]);
        expect(h.opened).toEqual(["made"]);
    });
});
