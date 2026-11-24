// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    calls: [] as { command: string; data: any; opts: any }[],
    answer: null as any,
    failure: null as Error,
    clientMeta: {} as Record<string, any>,
}));

vi.mock("@/app/store/global", () => ({
    atoms: { workspace: "workspace" },
    globalStore: { get: (atom: string) => (atom === "client" ? { meta: h.clientMeta } : null) },
}));
vi.mock("@/app/store/client-model", () => ({ ClientModel: { getInstance: () => ({ clientAtom: "client" }) } }));
vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {
        wshRpcCall: async (command: string, data: any, opts: any) => {
            h.calls.push({ command, data, opts });
            if (h.failure != null) {
                throw h.failure;
            }
            return h.answer;
        },
    },
}));

import {
    ContextFolderCheckCommand,
    ContextFolderCommand,
    ContextsMetaKey,
    ContextsRoute,
    WorkspaceContextMetaKey,
} from "./context-model";
import { checkWorkspaceFolder, clearContextFolder, setContextFolder } from "./context-store";

function workspace(contextId: string): Workspace {
    return {
        oid: "ws1",
        otype: "workspace",
        version: 1,
        tabids: [],
        activetabid: "",
        meta: { [WorkspaceContextMetaKey]: contextId },
    } as Workspace;
}

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    h.calls = [];
    h.answer = { contexts: [] };
    h.failure = null;
    h.clientMeta = { [ContextsMetaKey]: [{ id: "workshop" }, { id: "client", folder: "/clients/sefers" }] };
});

describe("a context's folder (#2518)", () => {
    it("is set with one call of the contexts route", async () => {
        await setContextFolder("client", "/clients/sefers");
        expect(h.calls).toEqual([
            {
                command: ContextFolderCommand,
                data: { id: "client", folder: "/clients/sefers" },
                opts: expect.objectContaining({ route: ContextsRoute }),
            },
        ]);
    });

    it("is cleared by sending no folder, which forgets it", async () => {
        await clearContextFolder("client");
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0].command).toBe(ContextFolderCommand);
        expect(h.calls[0].data).toEqual({ id: "client", folder: "" });
    });

    it("lets the route's refusal reach the caller", async () => {
        h.failure = new Error("the folder of a context must be an absolute path");
        await expect(setContextFolder("client", "x")).rejects.toThrow("absolute path");
    });
});

describe("checkWorkspaceFolder (#2518)", () => {
    it("asks wavesrv, which follows symbolic links, and returns its answer", async () => {
        h.answer = { outside: true, contextfolder: "/real/sefers", folder: "/archive/x" };
        const result = await checkWorkspaceFolder(workspace("client"), "/clients/sefers/link/x");
        expect(result).toEqual({ outside: true, contextfolder: "/real/sefers", folder: "/archive/x" });
        expect(h.calls).toEqual([
            {
                command: ContextFolderCheckCommand,
                data: { workspaceid: "ws1", folder: "/clients/sefers/link/x" },
                opts: expect.objectContaining({ route: ContextsRoute }),
            },
        ]);
    });

    it("compares the paths as written when wavesrv cannot be asked, and still asks for a folder outside", async () => {
        h.failure = new Error("no route");
        expect((await checkWorkspaceFolder(workspace("client"), "/clients/sefers2")).outside).toBe(true);
        expect((await checkWorkspaceFolder(workspace("client"), "/clients/sefers/app/")).outside).toBe(false);
        expect((await checkWorkspaceFolder(workspace("client"), "/clients/sefers/../x")).outside).toBe(true);
    });

    it("asks nothing of a workspace whose context sets no folder, when wavesrv cannot be asked", async () => {
        h.failure = new Error("no route");
        expect((await checkWorkspaceFolder(workspace("workshop"), "/home/me")).outside).toBe(false);
    });

    it("asks nothing when no folder is chosen", async () => {
        h.failure = new Error("no route");
        expect((await checkWorkspaceFolder(workspace("client"), "")).outside).toBe(false);
    });
});
