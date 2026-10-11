// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, it, vi } from "vitest";

// A workspace the renderer has never seen stays "loading" (null) until its fetch answers: the fetch never answers
// here, which is the frame where hidden views used to crash.
vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

import { atoms, initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { pinTabWorkspace, subscribeWindowWorkspaceChange } from "./tab-workspace";

const WindowId = "win-1";
const TabA = "tab-a";

function wsObj(oid: string, version: number, tabids: string[]): Workspace {
    return { otype: "workspace", oid, version, name: oid, tabids, activetabid: tabids[0] } as Workspace;
}

function winObj(workspaceid: string, version: number): WaveWindow {
    return { otype: "window", oid: WindowId, version, workspaceid } as WaveWindow;
}

function update(obj: WaveObj) {
    WOS.updateWaveObject({ updatetype: "update", otype: obj.otype, oid: obj.oid, obj });
}

describe("a tab view keeps its own workspace (FR-PERF-001)", () => {
    beforeAll(() => {
        initGlobalAtoms({ tabId: TabA, windowId: WindowId, clientId: "client-1", platform: "darwin" } as any);
        update(wsObj("ws-a", 1, [TabA]));
        update(winObj("ws-a", 1));
        pinTabWorkspace("ws-a");
    });

    it("sees its workspace while the window is on it", () => {
        expect(globalStore.get(atoms.workspace)?.oid).toBe("ws-a");
    });

    it("never reads a null workspace when the window moves to a workspace created elsewhere", () => {
        const seen: string[] = [];
        const unsub = globalStore.sub(atoms.workspace, () =>
            seen.push(globalStore.get(atoms.workspace)?.oid ?? "null")
        );
        update(winObj("ws-new", 2));
        expect(globalStore.get(atoms.workspace)?.oid).toBe("ws-a");
        expect(seen).not.toContain("null");
        unsub();
    });

    it("does not follow the window to another cached workspace either", () => {
        update(wsObj("ws-b", 1, ["tab-b"]));
        update(winObj("ws-b", 3));
        expect(globalStore.get(atoms.workspaceId)).toBe("ws-a");
    });

    it("tells its subscribers when the window leaves for another workspace", () => {
        const calls: string[] = [];
        const unsub = subscribeWindowWorkspaceChange(() => calls.push("left"));
        update(winObj("ws-c", 4));
        update(winObj("ws-c", 5));
        expect(calls).toEqual(["left"]);
        unsub();
    });

    it("reads null once its own workspace is deleted (the guard renders the pending state)", () => {
        WOS.updateWaveObject({ updatetype: "delete", otype: "workspace", oid: "ws-a" });
        expect(globalStore.get(atoms.workspace)).toBeNull();
    });
});
