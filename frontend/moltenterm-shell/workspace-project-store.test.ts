// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({
    workspaces: {} as Record<string, any>,
    gitDirs: new Set<string>(),
    setMeta: [] as { oref: string; meta: Record<string, any> }[],
}));

vi.mock("@/app/store/global", () => ({ getApi: () => ({}) }));
vi.mock("@/app/store/services", () => ({ WorkspaceService: {} }));
vi.mock("@/app/store/jotaiStore", () => ({ globalStore: { get: (oref: string) => app.workspaces[oref] } }));
vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    getWaveObjectAtom: (oref: string) => oref,
}));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        FileInfoCommand: (_client: any, data: { info: { path: string } }) =>
            Promise.resolve(app.gitDirs.has(data.info.path) ? { isdir: true } : { notfound: true }),
        SetMetaCommand: (_client: any, data: { oref: string; meta: Record<string, any> }) => {
            app.setMeta.push(data);
            return Promise.resolve();
        },
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

import { linkWorkspaceProject, setWorkspaceFolder } from "./workspace-project-store";
import { ProjectMetaKey, WorkspaceRecentFoldersMetaKey } from "./workspace-project";

describe("linkWorkspaceProject (#749)", () => {
    beforeEach(() => {
        app.workspaces = {};
        app.gitDirs = new Set(["/work/proj/.git"]);
        app.setMeta = [];
    });

    it("puts the linked folder first in the workspace's recent folders", async () => {
        const ws = { oid: "ws1", meta: { [WorkspaceRecentFoldersMetaKey]: ["/home/me", "/work/proj"] } } as any;
        app.workspaces["workspace:ws1"] = ws;
        expect(await linkWorkspaceProject(ws, "/work/proj/src")).toBe("/work/proj");
        expect(app.setMeta).toHaveLength(1);
        expect(app.setMeta[0].oref).toBe("workspace:ws1");
        expect(app.setMeta[0].meta[ProjectMetaKey]).toBe("/work/proj");
        expect(app.setMeta[0].meta[WorkspaceRecentFoldersMetaKey]).toEqual(["/work/proj", "/home/me"]);
    });

    it("reads the latest workspace, so a folder set just before the link stays in the history", async () => {
        const stale = { oid: "ws1", meta: {} } as any;
        app.workspaces["workspace:ws1"] = { oid: "ws1", meta: { [WorkspaceRecentFoldersMetaKey]: ["/work/proj/src"] } };
        await linkWorkspaceProject(stale, "/work/proj");
        expect(app.setMeta[0].meta[WorkspaceRecentFoldersMetaKey]).toEqual(["/work/proj", "/work/proj/src"]);
    });

    it("still records a folder set on a workspace the store has not loaded", async () => {
        await setWorkspaceFolder("ws2", "/work/proj");
        expect(app.setMeta[0].meta[WorkspaceRecentFoldersMetaKey]).toEqual(["/work/proj"]);
    });
});
