// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/services", () => ({ WorkspaceService: {} }));
vi.mock("./emain-window", () => ({ createWindowForWorkspace: vi.fn(), getWaveWindowByWorkspaceId: vi.fn() }));

import { openWorkspaceWindow, OpenWorkspaceWindowDeps } from "./moltenterm-contexts-ipc";

function makeDeps(known: string[], shown: Record<string, { show: () => void; focus: () => void }> = {}) {
    const opened: string[] = [];
    const deps: OpenWorkspaceWindowDeps = {
        exists: async (id) => known.includes(id),
        windowOf: (id) => shown[id] ?? null,
        open: async (id) => {
            opened.push(id);
        },
    };
    return { deps, opened };
}

describe("openWorkspaceWindow", () => {
    it("opens a window on a workspace no window shows", async () => {
        const { deps, opened } = makeDeps(["a"]);
        expect(await openWorkspaceWindow("a", deps)).toBe("opened");
        expect(opened).toEqual(["a"]);
    });

    it("brings the window that shows the workspace forward, and opens no second one", async () => {
        const window = { show: vi.fn(), focus: vi.fn() };
        const { deps, opened } = makeDeps(["a"], { a: window });
        expect(await openWorkspaceWindow("a", deps)).toBe("focused");
        expect(window.show).toHaveBeenCalledTimes(1);
        expect(window.focus).toHaveBeenCalledTimes(1);
        expect(opened).toEqual([]);
    });

    it("refuses what is not the id of a workspace that exists", async () => {
        const { deps, opened } = makeDeps(["a"]);
        for (const value of [undefined, null, "", 4, {}, ["a"], "ghost"]) {
            expect(await openWorkspaceWindow(value, deps)).toBe("invalid");
        }
        expect(opened).toEqual([]);
    });
});
