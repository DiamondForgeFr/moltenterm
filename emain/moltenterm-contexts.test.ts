// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/services", () => ({ ClientService: {}, WorkspaceService: {} }));
vi.mock("./emain-wsh", () => ({ ElectronWshClient: {} }));

import { ContextsBackend, placeInContextOf } from "./moltenterm-contexts";

function makeBackend(workspaces: Record<string, string>, stored: boolean = true) {
    const assigned: [string, string][] = [];
    const backend: ContextsBackend = {
        clientMeta: async () =>
            stored ? { "molten:contexts": [{ id: "first" }, { id: "second" }, { id: "third" }] } : {},
        workspaceMeta: async (id) => (workspaces[id] ? { "molten:context": workspaces[id] } : {}),
        assign: async (workspaceId, contextId) => {
            assigned.push([workspaceId, contextId]);
        },
    };
    return { backend, assigned };
}

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
