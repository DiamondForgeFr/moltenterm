// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the folders do to the workspace (FR-SHELL-080, #2484): a folder is made, filled, emptied, renamed and dissolved
// through the workspace's meta and tab order, persists with the workspace, goes when its views go, and Clear leaves it.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetMetaCommand: vi.fn(async () => {}),
        UpdateWorkspaceTabIdsCommand: vi.fn(async () => {}),
    },
}));
vi.mock("@/app/store/wos", async (orig) => ({
    ...(await orig<typeof import("@/app/store/wos")>()),
    reloadWaveObject: vi.fn(async () => null),
}));

import { atoms, initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { pinTabWorkspace } from "../tab-workspace";
import { clearableViews } from "./temporary-clear";
import { ViewFoldersMetaKey } from "./view-folders-model";
import {
    addViewToFolder,
    closeFolder,
    dissolveViewFolder,
    dropViewOnView,
    folderMenuFor,
    folderNoteAtom,
    moveViewInFolder,
    openFolder,
    openFolderAtom,
    pendingFoldersAtom,
    pruneStoredFolders,
    renameViewFolder,
    takeViewOut,
    viewFoldersAtom,
} from "./view-folders-store";

const WorkspaceId = "ws-fo";

function update(obj: WaveObj) {
    WOS.updateWaveObject({ updatetype: "update", otype: obj.otype, oid: obj.oid, obj });
}

let version = 1;

// The workspace as wavesrv would have echoed it.
function seed(
    tabids: string[],
    folders: any[] = null,
    tabMeta: Record<string, Record<string, any>> = {},
    workspaceMeta: Record<string, any> = {}
) {
    version++;
    for (const id of tabids) {
        update({ otype: "tab", oid: id, version, name: id, blockids: [], meta: tabMeta[id] ?? {} } as Tab);
    }
    update({
        otype: "workspace",
        oid: WorkspaceId,
        version,
        tabids,
        meta: { ...(folders == null ? {} : { [ViewFoldersMetaKey]: folders }), ...workspaceMeta },
    } as unknown as Workspace);
}

const setMeta = vi.mocked(RpcApi.SetMetaCommand);
const setOrder = vi.mocked(RpcApi.UpdateWorkspaceTabIdsCommand);

function savedFolders(): any[] {
    const call = setMeta.mock.calls.at(-1);
    return (call?.[1] as any)?.meta?.[ViewFoldersMetaKey];
}

beforeAll(() => {
    initGlobalAtoms({ tabId: "t-a", windowId: "win-fo", clientId: "c", platform: "darwin" } as any);
    update({ otype: "window", oid: "win-fo", version: 1, workspaceid: WorkspaceId } as WaveWindow);
    seed(["t-a", "t-b", "t-c", "t-d"]);
    pinTabWorkspace(WorkspaceId);
});

beforeEach(() => {
    setMeta.mockClear();
    setOrder.mockClear();
    closeFolder();
    globalStore.set(pendingFoldersAtom, null);
    seed(["t-a", "t-b", "t-c", "t-d"]);
});

describe("making a folder (#2484)", () => {
    it("makes a folder of two views, side by side in the tab order, and saves it with the workspace", async () => {
        await dropViewOnView("t-d", "t-b");
        expect(setOrder).toHaveBeenCalledWith({}, WorkspaceId, ["t-a", "t-b", "t-d", "t-c"]);
        const saved = savedFolders();
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ name: "", tabids: ["t-b", "t-d"] });
        expect(saved[0].id).toBeTruthy();
        expect(globalStore.get(folderNoteAtom)).toContain("2");
    });

    it("shows the new folder at once, before wavesrv echoes it", async () => {
        let echoed: () => void = null;
        setMeta.mockImplementationOnce(() => new Promise<void>((resolve) => (echoed = resolve)));
        const writing = dropViewOnView("t-a", "t-b");
        await vi.waitFor(() => expect(globalStore.get(viewFoldersAtom).map((f) => f.tabids)).toEqual([["t-b", "t-a"]]));
        echoed();
        await writing;
        expect(globalStore.get(pendingFoldersAtom)).toBeNull();
    });

    it("reads the folders back from the workspace after a restart", () => {
        seed(["t-a", "t-b", "t-c"], [{ id: "f1", name: "Review", tabids: ["t-a", "t-c"] }]);
        expect(globalStore.get(viewFoldersAtom)).toEqual([{ id: "f1", name: "Review", tabids: ["t-a", "t-c"] }]);
    });

    it("adds a view to a folder, after its last view", async () => {
        seed(["t-a", "t-b", "t-c", "t-d"], [{ id: "f1", name: "", tabids: ["t-a", "t-b"] }]);
        await addViewToFolder("f1", "t-d");
        expect(setOrder).toHaveBeenCalledWith({}, WorkspaceId, ["t-a", "t-b", "t-d", "t-c"]);
        expect(savedFolders()[0].tabids).toEqual(["t-a", "t-b", "t-d"]);
    });

    it("adds a view dropped on one of a folder's views to that folder", async () => {
        seed(["t-a", "t-b", "t-c", "t-d"], [{ id: "f1", name: "", tabids: ["t-a", "t-b"] }]);
        await dropViewOnView("t-d", "t-b");
        expect(savedFolders()).toHaveLength(1);
        expect(savedFolders()[0].tabids).toEqual(["t-a", "t-b", "t-d"]);
    });
});

describe("emptying and renaming a folder", () => {
    beforeEach(() => {
        seed(["t-a", "t-b", "t-c", "t-d"], [{ id: "f1", name: "", tabids: ["t-a", "t-b", "t-c"] }]);
    });

    it("takes a view out right after its folder, and keeps a folder of two", async () => {
        await takeViewOut("t-a");
        expect(setOrder).toHaveBeenCalledWith({}, WorkspaceId, ["t-b", "t-c", "t-a", "t-d"]);
        expect(savedFolders()[0].tabids).toEqual(["t-b", "t-c"]);
    });

    it("takes a view out before a row of the list, or at its end", async () => {
        await takeViewOut("t-a", { before: "t-d" });
        expect(setOrder).toHaveBeenLastCalledWith({}, WorkspaceId, ["t-b", "t-c", "t-a", "t-d"]);
        await takeViewOut("t-b", { end: true });
        expect(setOrder).toHaveBeenLastCalledWith({}, WorkspaceId, ["t-a", "t-c", "t-d", "t-b"]);
    });

    it("dissolves a folder left with one view", async () => {
        seed(["t-a", "t-b", "t-c", "t-d"], [{ id: "f1", name: "", tabids: ["t-a", "t-b"] }]);
        await takeViewOut("t-a");
        expect(setMeta.mock.calls.at(-1)?.[1]).toMatchObject({ meta: { [ViewFoldersMetaKey]: null } });
    });

    it("renames, and an empty name gives the name back to the content", async () => {
        await renameViewFolder("f1", "  Reviews ");
        expect(savedFolders()[0].name).toBe("Reviews");
        setMeta.mockClear();
        await renameViewFolder("f1", "");
        expect(setMeta).not.toHaveBeenCalled();
    });

    it("dissolves a folder on request, its views staying where they are", async () => {
        await dissolveViewFolder("f1");
        expect(setMeta.mock.calls.at(-1)?.[1]).toMatchObject({ meta: { [ViewFoldersMetaKey]: null } });
        expect(setOrder).not.toHaveBeenCalled();
    });

    it("moves a view one place inside its folder", async () => {
        await moveViewInFolder("f1", "t-a", 1);
        expect(savedFolders()[0].tabids).toEqual(["t-b", "t-a", "t-c"]);
        expect(globalStore.get(folderNoteAtom)).toContain("2");
        setMeta.mockClear();
        await moveViewInFolder("f1", "t-c", 1);
        expect(setMeta).not.toHaveBeenCalled();
    });
});

describe("a folder goes when its views go", () => {
    it("loses a view closed for good, and dissolves when one is left", async () => {
        seed(["t-a", "t-b", "t-d"], [{ id: "f1", name: "", tabids: ["t-a", "t-b", "t-c"] }]);
        pruneStoredFolders();
        await vi.waitFor(() => expect(setMeta).toHaveBeenCalledTimes(1));
        expect(savedFolders()[0].tabids).toEqual(["t-a", "t-b"]);
        seed(["t-a", "t-d"], [{ id: "f1", name: "", tabids: ["t-a", "t-b"] }]);
        pruneStoredFolders();
        await vi.waitFor(() => expect(setMeta).toHaveBeenCalledTimes(2));
        expect(setMeta.mock.calls.at(-1)?.[1]).toMatchObject({ meta: { [ViewFoldersMetaKey]: null } });
    });

    it("loses a view that was pinned, which the Views list no longer holds", async () => {
        seed(["t-a", "t-b", "t-c"], [{ id: "f1", name: "", tabids: ["t-a", "t-b", "t-c"] }], {
            "t-b": { "molten:pin": { name: "b" } },
        });
        pruneStoredFolders();
        await vi.waitFor(() => expect(setMeta).toHaveBeenCalledTimes(1));
        expect(savedFolders()[0].tabids).toEqual(["t-a", "t-c"]);
    });

    it("keeps a view set aside for its Undo in its folder", () => {
        seed(
            ["t-a", "t-b", "t-c"],
            [{ id: "f1", name: "", tabids: ["t-a", "t-b"] }],
            {},
            { "molten:hiddentabs": ["t-b"] }
        );
        pruneStoredFolders();
        expect(setMeta).not.toHaveBeenCalled();
    });

    it("closes the open grid of a folder that dissolved", () => {
        seed(["t-a", "t-b", "t-c"], [{ id: "f1", name: "", tabids: ["t-a", "t-x"] }]);
        openFolder("f1");
        pruneStoredFolders();
        expect(globalStore.get(openFolderAtom)).toBeNull();
    });

    it("changes nothing when every view is there", () => {
        seed(["t-a", "t-b", "t-c"], [{ id: "f1", name: "", tabids: ["t-a", "t-b"] }]);
        pruneStoredFolders();
        expect(setMeta).not.toHaveBeenCalled();
    });
});

describe("Clear keeps the folders (#2484)", () => {
    it("closes the views outside folders only", () => {
        seed(["t-a", "t-b", "t-c", "t-d"], [{ id: "f1", name: "", tabids: ["t-b", "t-c"] }]);
        expect(clearableViews()).toEqual(["t-a", "t-d"]);
    });

    it("closes every view with no folder", () => {
        seed(["t-a", "t-b"]);
        expect(clearableViews()).toEqual(["t-a", "t-b"]);
    });

    it("closes the views of a folder shown with one view only", () => {
        seed(["t-a", "t-b"], [{ id: "f1", name: "", tabids: ["t-a", "t-gone"] }]);
        expect(clearableViews()).toEqual(["t-a", "t-b"]);
    });
});

describe("what a view's menu offers about folders", () => {
    it("offers the nearest other views and the folders, and no taking out", () => {
        seed(["t-a", "t-b", "t-c", "t-d", "t-e"], [{ id: "f1", name: "Mine", tabids: ["t-d", "t-e"] }]);
        const hooks = folderMenuFor("t-b");
        expect(hooks.partners.map((p) => p.tabId)).toEqual(["t-a", "t-c"]);
        expect(hooks.folders).toEqual([{ id: "f1", name: "Mine" }]);
        expect(hooks.takeOut).toBeUndefined();
    });

    it("offers taking a view out of its folder, and the other folders, not its own", () => {
        seed(
            ["t-a", "t-b", "t-c", "t-d", "t-e"],
            [
                { id: "f1", name: "One", tabids: ["t-a", "t-b"] },
                { id: "f2", name: "Two", tabids: ["t-d", "t-e"] },
            ]
        );
        const hooks = folderMenuFor("t-a");
        expect(hooks.partners).toEqual([]);
        expect(hooks.folders.map((f) => f.id)).toEqual(["f2"]);
        expect(hooks.takeOut).toBeTypeOf("function");
    });

    it("offers nothing with no other view and no folder", () => {
        seed(["t-a"]);
        const hooks = folderMenuFor("t-a");
        expect(hooks.partners).toEqual([]);
        expect(hooks.folders).toEqual([]);
    });
});

describe("the workspace atom the folders read", () => {
    it("is the window's workspace", () => {
        expect(globalStore.get(atoms.workspace)?.oid).toBe(WorkspaceId);
    });
});
