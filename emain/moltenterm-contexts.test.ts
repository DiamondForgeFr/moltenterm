// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/services", () => ({ ClientService: {}, WorkspaceService: {} }));
vi.mock("./emain-wsh", () => ({ ElectronWshClient: {} }));

import { ContextsBackend, landingInContextOf, placeInContextOf } from "./moltenterm-contexts";

function makeBackend(workspaces: Record<string, string>, stored: boolean = true) {
    const assigned: [string, string][] = [];
    const landed: string[] = [];
    const backend: ContextsBackend = {
        clientMeta: async () =>
            stored ? { "molten:contexts": [{ id: "first" }, { id: "second" }, { id: "third" }] } : {},
        workspaceMeta: async (id) => (workspaces[id] ? { "molten:context": workspaces[id] } : {}),
        assign: async (workspaceId, contextId) => {
            assigned.push([workspaceId, contextId]);
        },
        landing: async (deletedWorkspaceId) => {
            landed.push(deletedWorkspaceId);
            return `landing-of-${deletedWorkspaceId}`;
        },
    };
    return { backend, assigned, landed };
}

describe("landingInContextOf", () => {
    it("asks wavesrv for the workspace the window lands on, in the context of the one it leaves", async () => {
        const { backend, landed } = makeBackend({});
        await expect(landingInContextOf("gone", backend)).resolves.toBe("landing-of-gone");
        expect(landed).toEqual(["gone"]);
    });

    it("answers nothing without a workspace, or when wavesrv names none", async () => {
        const { backend, landed } = makeBackend({});
        await expect(landingInContextOf("", backend)).resolves.toBeNull();
        await expect(landingInContextOf(undefined, backend)).resolves.toBeNull();
        expect(landed).toEqual([]);
        backend.landing = async () => "";
        await expect(landingInContextOf("gone", backend)).resolves.toBeNull();
    });

    it("lets the caller land the window by the rail's order when wavesrv cannot be asked", async () => {
        const { backend } = makeBackend({});
        backend.landing = async () => {
            throw new Error("wavesrv is gone");
        };
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await expect(landingInContextOf("gone", backend)).resolves.toBeNull();
        expect(log).toHaveBeenCalled();
        log.mockRestore();
    });
});

describe("placeInContextOf", () => {
    it("puts a new workspace in the context of the workspace it comes from", async () => {
        const { backend, assigned } = makeBackend({ shown: "second" });
        await placeInContextOf("new", "shown", backend);
        expect(assigned).toEqual([["new", "second"]]);
    });

    it("writes nothing for the first context, which holds every workspace that names none", async () => {
        const { backend, assigned } = makeBackend({ shown: "first", other: "" });
        await placeInContextOf("new", "shown", backend);
        await placeInContextOf("new", "other", backend);
        await placeInContextOf("new", "unknown", backend);
        expect(assigned).toEqual([]);
    });

    it("writes nothing when the contexts were never stored", async () => {
        const { backend, assigned } = makeBackend({ shown: "second" }, false);
        await placeInContextOf("new", "shown", backend);
        expect(assigned).toEqual([]);
    });

    it("writes nothing without a workspace to follow", async () => {
        const { backend, assigned } = makeBackend({});
        await placeInContextOf("new", "", backend);
        await placeInContextOf("", "shown", backend);
        await placeInContextOf("new", undefined, backend);
        expect(assigned).toEqual([]);
    });

    it("never stops the new workspace when the write fails", async () => {
        const { backend } = makeBackend({ shown: "second" });
        backend.assign = async () => {
            throw new Error("wavesrv is gone");
        };
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await expect(placeInContextOf("new", "shown", backend)).resolves.toBeUndefined();
        expect(log).toHaveBeenCalled();
        log.mockRestore();
    });
});
