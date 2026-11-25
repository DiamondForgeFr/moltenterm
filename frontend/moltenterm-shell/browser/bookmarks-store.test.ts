// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

// lag: the window's copy of the client follows a save later than the save's answer (the update arrives after the RPC
// returns); the test calls arrive() to let it in. A write yields once before it applies, so two changes started together
// interleave there if nothing keeps them apart.
const { state } = vi.hoisted(() => ({
    state: {
        client: null as any,
        writes: [] as { oref: string; meta: Record<string, any> }[],
        failWrites: false,
        lag: false,
        late: [] as (() => void)[],
        serial: 0,
    },
}));

vi.mock("@/app/store/client-model", () => ({
    ClientModel: { getInstance: () => ({ clientAtom: { name: "client" } }) },
}));
vi.mock("@/app/store/global", () => ({
    globalStore: { get: () => state.client },
}));
vi.mock("@/app/store/wos", () => ({
    makeORef: (otype: string, oid: string) => `${otype}:${oid}`,
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetMetaCommand: async (_client: unknown, data: { oref: string; meta: Record<string, any> }) => {
            await Promise.resolve();
            if (state.failWrites) {
                throw new Error("offline");
            }
            state.writes.push(data);
            const apply = () => {
                const meta = { ...state.client.meta };
                for (const [key, value] of Object.entries(data.meta)) {
                    if (value == null) {
                        delete meta[key];
                    } else {
                        meta[key] = JSON.parse(JSON.stringify(value));
                    }
                }
                state.client = { ...state.client, meta, version: state.client.version + 1 };
            };
            if (state.lag) {
                state.late.push(apply);
                return;
            }
            apply();
        },
    },
}));

import {
    BookmarkLimits,
    BookmarksMetaKey,
    LevelApp,
    LevelContext,
    LevelProject,
    LevelWorkspace,
    projectPlaceId,
    readStore,
    visibleFrom,
    type Here,
    type PlaceRef,
} from "./bookmarks";
import {
    addBookmarkAt,
    addPageAt,
    copyBookmarkAt,
    createFolderAt,
    deleteFolderAt,
    editBookmark,
    moveBookmarkTo,
    placeBookmarkAt,
    removeBookmarkEverywhere,
    renameFolderAt,
    unplaceBookmarkAt,
} from "./bookmarks-store";

const App: PlaceRef = { level: LevelApp, id: "" };
const Ctx: PlaceRef = { level: LevelContext, id: "ctx1" };
const Ws: PlaceRef = { level: LevelWorkspace, id: "w1" };
const P1: PlaceRef = { level: LevelProject, id: projectPlaceId("w1", "p1") };
const P2: PlaceRef = { level: LevelProject, id: projectPlaceId("w1", "p2") };

const Here1: Here = { contextId: "ctx1", workspaceId: "w1", projectId: "p1" };

const page = (extra: Record<string, string> = {}) => ({
    url: "https://vite.dev/config/",
    title: "Vite config",
    description: "",
    ...extra,
});

function store() {
    return readStore(state.client.meta);
}

beforeEach(() => {
    // Another client each test: what the store remembers of a save belongs to one client.
    state.client = { oid: `c${++state.serial}`, version: 1, meta: {} };
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

describe("the bookmarks of the app, kept in the client's meta (#2531)", () => {
    it("writes one key on the client object, never on a workspace", async () => {
        const added = await addBookmarkAt(page({ description: "The build options." }), P1, { newFolder: "Docs" });
        expect(added.problem).toBeNull();
        expect(state.writes).toHaveLength(1);
        expect(state.writes[0].oref).toBe(`client:${state.client.oid}`);
        expect(Object.keys(state.writes[0].meta)).toEqual([BookmarksMetaKey]);
        const read = store();
        expect(read.records).toHaveLength(1);
        expect(read.records[0]).toMatchObject({
            url: "https://vite.dev/config/",
            description: "The build options.",
            places: [{ level: "project", id: P1.id }],
        });
        expect(read.folders[`project:${P1.id}`].map((f) => f.name)).toEqual(["Docs"]);
    });

    it("keeps one record when a bookmark is placed at several levels, and its rename shows at every place", async () => {
        const added = await addBookmarkAt(page(), P1);
        const id = added.result.id;
        expect(await placeBookmarkAt(id, Ws)).toBeNull();
        expect(await placeBookmarkAt(id, Ctx)).toBeNull();
        expect(await placeBookmarkAt(id, App)).toBeNull();
        expect(store().records).toHaveLength(1);
        expect(store().records[0].places.map((p) => p.level)).toEqual(["project", "workspace", "context", "app"]);
        expect(await editBookmark(id, page({ title: "Renamed", description: "A note." }))).toBeNull();
        const [record] = store().records;
        expect(record).toMatchObject({ title: "Renamed", description: "A note." });
        expect(visibleFrom(store(), Here1)).toEqual([record]);
        expect(visibleFrom(store(), { contextId: "ctx9", workspaceId: "w9", projectId: null })).toEqual([record]);
    });

    it("removes a bookmark from one place only, and everywhere in one write", async () => {
        const id = (await addBookmarkAt(page(), P1)).result.id;
        await placeBookmarkAt(id, Ws);
        await placeBookmarkAt(id, App);
        expect(await unplaceBookmarkAt(id, Ws)).toBeNull();
        expect(store().records[0].places.map((p) => p.level)).toEqual(["project", "app"]);
        state.writes = [];
        expect(await removeBookmarkEverywhere(id)).toBeNull();
        expect(state.writes).toHaveLength(1);
        expect(store().records).toEqual([]);
        expect(state.client.meta[BookmarksMetaKey]).toBeUndefined();
    });

    it("deletes the bookmark when its last place is removed", async () => {
        const id = (await addBookmarkAt(page(), P1)).result.id;
        expect(await unplaceBookmarkAt(id, P1)).toBeNull();
        expect(store().records).toEqual([]);
    });

    it("keeps a folder per place for the same bookmark, and moves between places", async () => {
        const id = (await addBookmarkAt(page(), P1)).result.id;
        expect(await createFolderAt(P1, "Docs")).toBeNull();
        expect(await createFolderAt(Ws, "Environments")).toBeNull();
        const docs = store().folders[`project:${P1.id}`][0].id;
        const environments = store().folders[`workspace:w1`][0].id;
        await placeBookmarkAt(id, P1, { folder: docs });
        await placeBookmarkAt(id, Ws, { folder: environments });
        expect(store().records[0].places).toEqual([
            { level: "project", id: P1.id, folder: docs },
            { level: "workspace", id: "w1", folder: environments },
        ]);
        expect(await moveBookmarkTo(id, P1, P2)).toBeNull();
        expect(store().records[0].places.map((p) => p.id)).toEqual(["w1", P2.id]);
        expect(await renameFolderAt(Ws, environments, "Stages")).toBeNull();
        expect(store().folders["workspace:w1"][0].name).toBe("Stages");
        expect(await deleteFolderAt(Ws, environments)).toBeNull();
        expect(store().records[0].places.find((p) => p.level === "workspace").folder).toBe("");
    });

    it("places the existing bookmark when the page is added at a place, and copies on request", async () => {
        const id = (await addBookmarkAt(page(), P1)).result.id;
        const placed = await addPageAt(page(), Ws);
        expect(placed.problem).toBeNull();
        expect(placed.result.id).toBe(id);
        expect(store().records).toHaveLength(1);
        const copy = await copyBookmarkAt(id, App);
        expect(copy.problem).toBeNull();
        expect(copy.result.id).not.toBe(id);
        expect(store().records).toHaveLength(2);
        expect((await addPageAt(page(), Ws)).problem).toBe("browser.bookmarks.problem.alreadyThere");
    });

    it("says the problem and writes nothing when a change is refused", async () => {
        await addBookmarkAt(page(), P1);
        state.writes = [];
        expect((await addBookmarkAt(page(), P1)).problem).toBe("browser.bookmarks.problem.alreadyThere");
        expect((await addBookmarkAt(page({ url: "ftp://x.example/" }), P1)).problem).toBe(
            "browser.bookmarks.problem.notWeb"
        );
        expect(await placeBookmarkAt("nope", Ws)).toBe("browser.bookmarks.problem.gone");
        expect(state.writes).toEqual([]);
    });

    it("says so when the save fails, and the next change starts from what the client really holds", async () => {
        state.failWrites = true;
        expect((await addBookmarkAt(page(), P1)).problem).toBe("browser.bookmarks.problem.notSaved");
        expect(store().records).toEqual([]);
        state.failWrites = false;
        expect((await addBookmarkAt(page(), P1)).problem).toBeNull();
        expect(store().records).toHaveLength(1);
    });

    it("keeps to the limits of a place", async () => {
        for (let i = 0; i < BookmarkLimits.folders; i++) {
            expect(await createFolderAt(Ws, `folder ${i}`)).toBeNull();
        }
        expect(await createFolderAt(Ws, "one more")).toBe("browser.bookmarks.problem.tooManyFolders");
    });
});

describe("changes made together all apply, each starting from the result of the one before", () => {
    it("two bookmarks added together are both kept", async () => {
        const [a, b] = await Promise.all([
            addBookmarkAt(page({ url: "https://a.example/" }), P1),
            addBookmarkAt(page({ url: "https://b.example/" }), P1),
        ]);
        expect(a.problem).toBeNull();
        expect(b.problem).toBeNull();
        expect(store().records.map((r) => r.url)).toEqual(["https://a.example/", "https://b.example/"]);
    });

    it("a move and a delete fired one after the other both apply", async () => {
        const a = (await addBookmarkAt(page({ url: "https://a.example/" }), P1)).result.id;
        const b = (await addBookmarkAt(page({ url: "https://b.example/" }), P1)).result.id;
        await Promise.all([moveBookmarkTo(a, P1, Ws), removeBookmarkEverywhere(b)]);
        expect(store().records.map((r) => [r.id, r.places.map((p) => p.level)])).toEqual([[a, ["workspace"]]]);
    });

    it("reads what the last save wrote while the window's copy of the client lags behind", async () => {
        state.lag = true;
        const first = addBookmarkAt(page({ url: "https://a.example/" }), P1);
        await first;
        const second = await addBookmarkAt(page({ url: "https://b.example/" }), P1);
        expect(second.problem).toBeNull();
        arrive();
        expect(store().records.map((r) => r.url)).toEqual(["https://a.example/", "https://b.example/"]);
    });

    it("lags a later change too: the third still sees the two before it", async () => {
        state.lag = true;
        await addBookmarkAt(page({ url: "https://a.example/" }), P1);
        arrive();
        await addBookmarkAt(page({ url: "https://b.example/" }), P1);
        await addBookmarkAt(page({ url: "https://c.example/" }), P1);
        arrive();
        arrive();
        expect(store().records.map((r) => r.url)).toEqual([
            "https://a.example/",
            "https://b.example/",
            "https://c.example/",
        ]);
    });
});
