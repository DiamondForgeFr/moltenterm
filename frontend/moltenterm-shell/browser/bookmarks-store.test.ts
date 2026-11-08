// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

// lag: the window's copy of the workspace follows a save later than the save's answer (the update arrives after the
// RPC returns); the test calls arrive() to let it in. A write yields once before it applies, so two changes started
// together interleave there if nothing keeps them apart.
const { state } = vi.hoisted(() => ({
    state: {
        ws: null as any,
        writes: [] as Record<string, any>[],
        failWrites: false,
        lag: false,
        late: [] as (() => void)[],
        serial: 0,
    },
}));

vi.mock("@/app/store/global", () => ({
    atoms: { workspace: { name: "workspace" } },
    globalStore: { get: () => state.ws },
}));
vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
    getWaveObjectAtom: () => ({}),
}));
vi.mock("../sidebar/workspace-projects-store", () => ({
    writeMeta: async (_ws: unknown, update: Record<string, any>) => {
        await Promise.resolve();
        if (state.failWrites) {
            throw new Error("offline");
        }
        state.writes.push(update);
        const apply = () => {
            const meta = { ...state.ws.meta };
            for (const [key, value] of Object.entries(update)) {
                if (value == null) {
                    delete meta[key];
                } else {
                    meta[key] = JSON.parse(JSON.stringify(value));
                }
            }
            state.ws = { ...state.ws, meta, version: state.ws.version + 1 };
        };
        if (state.lag) {
            state.late.push(apply);
            return;
        }
        apply();
    },
}));

import { BookmarksMetaKey, readProjectBookmarks } from "./bookmarks";
import {
    addProjectBookmark,
    copyProjectBookmark,
    createProjectFolder,
    deleteProjectBookmark,
    deleteProjectFolder,
    moveProjectBookmark,
    renameProjectFolder,
    updateProjectBookmark,
} from "./bookmarks-store";

function workspace() {
    return {
        // Another workspace each test: what the store remembers of a save belongs to one workspace.
        oid: `w${++state.serial}`,
        version: 1,
        meta: {
            "molten:projects": [
                { id: "p1", type: "Desktop", dir: "/work/app" },
                { id: "p2", type: "Website", dir: "/work/site" },
                { id: "p3", type: "Docs", dir: "/work/docs" },
            ],
            "molten:currentproject": "p1",
            "molten:project": "/work/app",
            "molten:projecttype": "Desktop",
        } as Record<string, any>,
    };
}

const A = "p1";
const B = "p2";
const C = "p3";

function view(project: string) {
    return readProjectBookmarks(state.ws.meta, project);
}

beforeEach(() => {
    state.ws = workspace();
    state.writes = [];
    state.failWrites = false;
    state.lag = false;
    state.late = [];
});

function arrive() {
    for (const apply of state.late.splice(0)) {
        apply();
    }
}

describe("the project bookmarks of a workspace", () => {
    it("are per project: a bookmark added in A with a folder and a note is not in B", async () => {
        const problem = await addProjectBookmark(state.ws, A, {
            url: "https://vite.dev/config/",
            title: "Vite config",
            description: "The build options the renderer relies on.",
            folder: "",
            newFolder: "Docs",
        });
        expect(problem).toBeNull();
        const a = view(A);
        expect(a.folders.map((f) => f.name)).toEqual(["Docs"]);
        expect(a.items).toHaveLength(1);
        expect(a.items[0]).toMatchObject({
            url: "https://vite.dev/config/",
            description: "The build options the renderer relies on.",
            folder: a.folders[0].id,
        });
        expect(view(B).items).toEqual([]);
        expect(view(C).items).toEqual([]);
        expect(Object.keys(state.ws.meta[BookmarksMetaKey])).toEqual([A]);
    });

    it("go in another project only when asked, as a copy that edits never follow", async () => {
        expect(
            await addProjectBookmark(
                state.ws,
                A,
                { url: "https://a.example.com", title: "A page", description: "Note", folder: "" },
                [B]
            )
        ).toBeNull();
        expect(view(A).items).toHaveLength(1);
        expect(view(B).items).toHaveLength(1);
        expect(view(C).items).toHaveLength(0);
        expect(view(A).items[0].id).not.toBe(view(B).items[0].id);
        expect(
            await updateProjectBookmark(state.ws, B, view(B).items[0].id, {
                url: "https://a.example.com",
                title: "Edited in B",
                description: "Other note",
                folder: "",
            })
        ).toBeNull();
        expect(view(B).items[0]).toMatchObject({ title: "Edited in B", description: "Other note" });
        expect(view(A).items[0]).toMatchObject({ title: "A page", description: "Note" });
        expect(state.writes).toHaveLength(2);
    });

    it("are not copied to a project that holds the address already, and the copy keeps the folder's name", async () => {
        await addProjectBookmark(state.ws, B, { url: "https://a.example.com", title: "", description: "", folder: "" });
        const problem = await addProjectBookmark(
            state.ws,
            A,
            { url: "https://a.example.com", title: "A page", description: "", folder: "", newFolder: "Ops" },
            [B, C]
        );
        expect(problem).toBeNull();
        expect(view(B).items).toHaveLength(1);
        expect(view(C).items).toHaveLength(1);
        expect(view(C).folders.map((f) => f.name)).toEqual(["Ops"]);
        expect(view(C).items[0].folder).toBe(view(C).folders[0].id);
    });

    it("copy to another project on an explicit action, and say when it cannot", async () => {
        await addProjectBookmark(state.ws, A, {
            url: "https://a.example.com",
            title: "A page",
            description: "",
            folder: "",
        });
        const id = view(A).items[0].id;
        expect(await copyProjectBookmark(state.ws, A, id, B)).toBeNull();
        expect(view(B).items.map((b) => b.url)).toEqual(["https://a.example.com/"]);
        expect(await copyProjectBookmark(state.ws, A, id, B)).toBe("browser.bookmarks.problem.alreadyThere");
        expect(await copyProjectBookmark(state.ws, A, id, A)).toBe("browser.bookmarks.problem.sameProject");
        expect(await copyProjectBookmark(state.ws, A, "gone", C)).toBe("browser.bookmarks.problem.gone");
    });

    it("move between folders, rename and delete a folder without losing a bookmark, and delete a bookmark", async () => {
        await addProjectBookmark(state.ws, A, {
            url: "https://a.example.com",
            title: "A",
            description: "",
            folder: "",
        });
        await createProjectFolder(state.ws, A, "Docs");
        const [folder] = view(A).folders;
        const bookmark = view(A).items[0];
        expect(await createProjectFolder(state.ws, A, "docs")).toBe("browser.bookmarks.problem.folderTaken");
        expect(await moveProjectBookmark(state.ws, A, bookmark.id, folder.id)).toBeNull();
        expect(view(A).items[0].folder).toBe(folder.id);
        expect(await renameProjectFolder(state.ws, A, folder.id, "Reference")).toBeNull();
        expect(view(A).folders[0].name).toBe("Reference");
        expect(await deleteProjectFolder(state.ws, A, folder.id)).toBeNull();
        expect(view(A).folders).toEqual([]);
        expect(view(A).items).toHaveLength(1);
        expect(view(A).items[0].folder).toBe("");
        expect(await deleteProjectBookmark(state.ws, A, bookmark.id)).toBeNull();
        expect(state.ws.meta[BookmarksMetaKey]).toBeUndefined();
    });

    it("drop the entry of a project the workspace no longer has, because ids are reused", async () => {
        await addProjectBookmark(state.ws, A, { url: "https://a.example.com", title: "", description: "", folder: "" });
        await addProjectBookmark(state.ws, C, { url: "https://c.example.com", title: "", description: "", folder: "" });
        state.ws = {
            ...state.ws,
            meta: {
                ...state.ws.meta,
                "molten:projects": state.ws.meta["molten:projects"].filter((p: any) => p.id !== C),
            },
        };
        await addProjectBookmark(state.ws, B, { url: "https://b.example.com", title: "", description: "", folder: "" });
        expect(Object.keys(state.ws.meta[BookmarksMetaKey]).sort()).toEqual([A, B]);
    });

    it("tell a failed save, and leave what was there", async () => {
        await addProjectBookmark(state.ws, A, { url: "https://a.example.com", title: "", description: "", folder: "" });
        state.failWrites = true;
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(
            await addProjectBookmark(state.ws, A, {
                url: "https://b.example.com",
                title: "",
                description: "",
                folder: "",
            })
        ).toBe("browser.bookmarks.problem.notSaved");
        spy.mockRestore();
        expect(view(A).items).toHaveLength(1);
    });

    it("refuse an unsafe address without writing anything", async () => {
        expect(
            await addProjectBookmark(state.ws, A, {
                url: "javascript:alert(1)",
                title: "",
                description: "",
                folder: "",
            })
        ).toBe("browser.bookmarks.problem.notWeb");
        expect(state.writes).toEqual([]);
    });
});

// Every change rewrites the whole key from what it read: changes started together must not erase each other.
describe("changes started together", () => {
    async function threeBookmarks() {
        for (const n of [1, 2, 3]) {
            await addProjectBookmark(state.ws, A, {
                url: `https://example.com/${n}`,
                title: `Page ${n}`,
                description: "",
                folder: "",
            });
        }
        await createProjectFolder(state.ws, A, "Docs");
        return view(A);
    }

    it("both apply when a move, a delete and a rename are fired without waiting", async () => {
        const start = await threeBookmarks();
        const [one, two, three] = start.items;
        const folder = start.folders[0].id;
        const results = await Promise.all([
            moveProjectBookmark(state.ws, A, one.id, folder),
            deleteProjectBookmark(state.ws, A, two.id),
            renameProjectFolder(state.ws, A, folder, "Reference"),
        ]);
        expect(results).toEqual([null, null, null]);
        const after = view(A);
        expect(after.items.map((b) => b.id)).toEqual([one.id, three.id]);
        expect(after.items[0].folder).toBe(folder);
        expect(after.folders[0].name).toBe("Reference");
    });

    it("both apply when the window's copy of the workspace has not caught up with the first save", async () => {
        const start = await threeBookmarks();
        const [one, two, three] = start.items;
        const writesBefore = state.writes.length;
        state.lag = true;
        const results = await Promise.all([
            deleteProjectBookmark(state.ws, A, one.id),
            deleteProjectBookmark(state.ws, A, two.id),
        ]);
        expect(results).toEqual([null, null]);
        arrive();
        expect(view(A).items.map((b) => b.id)).toEqual([three.id]);
        expect(state.writes).toHaveLength(writesBefore + 2);
    });

    it("starts from the workspace again once a newer version of it has arrived", async () => {
        const start = await threeBookmarks();
        state.lag = true;
        await deleteProjectBookmark(state.ws, A, start.items[0].id);
        arrive();
        // Another window's change reaches this one: the next change builds on it, not on what this window wrote.
        const meta = { ...state.ws.meta };
        meta[BookmarksMetaKey] = {
            [A]: { folders: [], items: view(A).items.filter((b) => b.id !== start.items[1].id) },
        };
        state.ws = { ...state.ws, meta, version: state.ws.version + 1 };
        state.lag = false;
        await deleteProjectBookmark(state.ws, A, start.items[2].id);
        expect(view(A).items).toEqual([]);
    });

    it("go on after one failed save", async () => {
        const start = await threeBookmarks();
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        state.failWrites = true;
        const failed = await deleteProjectBookmark(state.ws, A, start.items[0].id);
        state.failWrites = false;
        spy.mockRestore();
        expect(failed).toBe("browser.bookmarks.problem.notSaved");
        expect(await deleteProjectBookmark(state.ws, A, start.items[1].id)).toBeNull();
        expect(view(A).items.map((b) => b.id)).toEqual([start.items[0].id, start.items[2].id]);
    });
});

describe("a copy that does not fit in another project", () => {
    function fullProject() {
        return {
            folders: [],
            items: Array.from({ length: 300 }, (_, i) => ({
                id: `b${i}`,
                url: `https://full.example.com/${i}`,
                title: `Full ${i}`,
                description: "",
                folder: "",
            })),
        };
    }

    it("names that project, not the one being edited, and saves nothing", async () => {
        state.ws = { ...state.ws, meta: { ...state.ws.meta, [BookmarksMetaKey]: { [B]: fullProject() } } };
        const problem = await addProjectBookmark(
            state.ws,
            A,
            { url: "https://new.example.com/", title: "New", description: "", folder: "" },
            [B]
        );
        expect(problem).toEqual({ key: "browser.bookmarks.problem.alsoTooMany", project: "Website" });
        expect(view(A).items).toEqual([]);
        expect(view(B).items).toHaveLength(300);
        expect(state.writes).toEqual([]);
    });

    it("is named too when it is a copy from Settings", async () => {
        await addProjectBookmark(state.ws, A, {
            url: "https://new.example.com/",
            title: "New",
            description: "",
            folder: "",
        });
        state.ws = {
            ...state.ws,
            meta: { ...state.ws.meta, [BookmarksMetaKey]: { ...state.ws.meta[BookmarksMetaKey], [C]: fullProject() } },
        };
        const problem = await copyProjectBookmark(state.ws, A, view(A).items[0].id, C);
        expect(problem).toEqual({ key: "browser.bookmarks.problem.alsoTooMany", project: "Docs" });
    });
});
