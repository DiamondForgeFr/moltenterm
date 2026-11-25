// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { buildCatalog, type CatalogWorkspace } from "./bookmark-places";
import {
    addFlow,
    defaultPlace,
    finderItems,
    nextFinderIndex,
    placeRows,
    toggleAction,
} from "./bookmark-popover-model";
import {
    addBookmark,
    Bookmark,
    BookmarkStore,
    EmptyStore,
    Here,
    LevelApp,
    LevelContext,
    LevelProject,
    LevelWorkspace,
    placeBookmark,
    projectPlaceId,
    type PlaceRef,
} from "./bookmarks";

const App: PlaceRef = { level: LevelApp, id: "" };
const Ctx: PlaceRef = { level: LevelContext, id: "sefers" };
const Ws: PlaceRef = { level: LevelWorkspace, id: "w1" };
const P1: PlaceRef = { level: LevelProject, id: projectPlaceId("w1", "p1") };
const P2: PlaceRef = { level: LevelProject, id: projectPlaceId("w1", "p2") };
const MobileWs: PlaceRef = { level: LevelWorkspace, id: "w2" };

const Here1: Here = { contextId: "sefers", workspaceId: "w1", projectId: "p1" };

const workspaces: CatalogWorkspace[] = [
    {
        id: "w1",
        name: "Échanges",
        color: "#2fa6a0",
        contextId: "sefers",
        projects: [
            { id: "p1", name: "site-web" },
            { id: "p2", name: "app-mobile" },
        ],
    },
    { id: "w2", name: "Mobile", color: "#6b5bd6", contextId: "sefers", projects: [] },
];
const catalog = buildCatalog({ appName: "The whole app", contexts: [{ context: { id: "sefers" }, name: "SEFERS" }], workspaces });

let n = 0;
const makeId = (prefix: "b" | "f") => `${prefix}${++n}`;

function bookmarkAt(...refs: PlaceRef[]): { store: BookmarkStore; bookmark: Bookmark } {
    const added = addBookmark(
        EmptyStore,
        { url: "https://vite.dev/config/", title: "Vite config", description: "" },
        refs[0],
        {},
        makeId
    );
    let store = added.value.store;
    for (const ref of refs.slice(1)) {
        store = placeBookmark(store, added.value.bookmark.id, ref, {}, makeId).value;
    }
    return { store, bookmark: store.records[0] };
}

describe("where a new bookmark goes (mockup 2)", () => {
    it("is the tab's project, or the workspace when none is linked", () => {
        expect(defaultPlace(Here1)).toEqual(P1);
        expect(defaultPlace({ ...Here1, projectId: null })).toEqual(Ws);
    });
});

describe("the click on the add button", () => {
    const add = vi.fn(async (draft: { url: string; title: string }, ref: PlaceRef) => {
        const added = addBookmark(EmptyStore, { ...draft, description: "" }, ref, {}, makeId);
        return added.problem != null
            ? ({ problem: added.problem } as const)
            : ({ problem: null, result: added.value.bookmark } as const);
    });

    it("bookmarks a page that is a bookmark nowhere at once, at the default place, and opens its places", async () => {
        add.mockClear();
        const request = await addFlow({
            store: EmptyStore,
            here: Here1,
            url: "https://vite.dev/config/",
            title: "Vite config",
            add,
        });
        expect(add).toHaveBeenCalledTimes(1);
        expect(add.mock.calls[0][1]).toEqual(P1);
        expect(request).toMatchObject({ kind: "bookmark", fresh: true });
        expect((request as any).initial.places).toEqual([{ level: "project", id: P1.id, folder: "" }]);
    });

    it("adds at the workspace in a workspace with no project", async () => {
        add.mockClear();
        await addFlow({
            store: EmptyStore,
            here: { ...Here1, projectId: null },
            url: "https://vite.dev/config/",
            title: "Vite config",
            add,
        });
        expect(add.mock.calls[0][1]).toEqual(Ws);
    });

    it("opens the bookmark that is already here, adding nothing", async () => {
        add.mockClear();
        const { store, bookmark } = bookmarkAt(Ws);
        const request = await addFlow({ store, here: Here1, url: "https://vite.dev/config#top", title: "x", add });
        expect(add).not.toHaveBeenCalled();
        expect(request).toEqual({ kind: "bookmark", id: bookmark.id, fresh: false });
    });

    it("asks what to do with a page bookmarked only elsewhere, never adding a duplicate", async () => {
        add.mockClear();
        const other: PlaceRef = { level: LevelProject, id: projectPlaceId("w9", "p1") };
        const { store, bookmark } = bookmarkAt(other);
        const request = await addFlow({ store, here: Here1, url: "https://vite.dev/config/", title: "x", add });
        expect(add).not.toHaveBeenCalled();
        expect(request).toEqual({ kind: "elsewhere", id: bookmark.id });
    });

    it("gives nothing for a page that cannot be bookmarked, and the reason for one that is refused", async () => {
        add.mockClear();
        expect(
            await addFlow({ store: EmptyStore, here: Here1, url: "about:blank#moltenterm-start", title: "", add })
        ).toBeNull();
        expect(add).not.toHaveBeenCalled();
        const refused = await addFlow({
            store: EmptyStore,
            here: Here1,
            url: "https://user:secret@example.com/",
            title: "x",
            add,
        });
        expect(refused).toEqual({ kind: "problem", problem: "browser.bookmarks.problem.credentials" });
    });
});

describe("the rows of the places block (mockup 2)", () => {
    it("lists the four levels of here, checked where the bookmark is, each with its folder", () => {
        const { bookmark } = bookmarkAt(Ws);
        const rows = placeRows(bookmark, Here1);
        expect(rows.map((r) => [r.ref.level, r.checked, r.elsewhere])).toEqual([
            ["app", false, false],
            ["context", false, false],
            ["workspace", true, false],
            ["project", false, false],
        ]);
    });

    it("leaves out the project row when the workspace has no linked project", () => {
        const { bookmark } = bookmarkAt(Ws);
        const rows = placeRows(bookmark, { ...Here1, projectId: null });
        expect(rows.map((r) => r.ref.level)).toEqual(["app", "context", "workspace"]);
    });

    it("adds a checked row for a place that is not one of the levels of here, after them", () => {
        const { bookmark } = bookmarkAt(Ws, P2, MobileWs);
        const rows = placeRows(bookmark, Here1);
        expect(rows.slice(0, 4).every((r) => !r.elsewhere)).toBe(true);
        expect(rows.slice(4).map((r) => [r.ref.id, r.checked, r.elsewhere])).toEqual([
            [P2.id, true, true],
            ["w2", true, true],
        ]);
    });
});

describe("what a toggle does", () => {
    it("checks to place the same bookmark and unchecks to take it off that place only", () => {
        const { bookmark } = bookmarkAt(Ws, P1);
        expect(toggleAction(bookmark, App, true)).toEqual({ kind: "place" });
        expect(toggleAction(bookmark, Ws, false)).toEqual({ kind: "unplace" });
        expect(toggleAction(bookmark, P1, false)).toEqual({ kind: "unplace" });
    });

    it("unchecks the last place as a removal everywhere, since a bookmark with no place is seen nowhere", () => {
        const { bookmark } = bookmarkAt(Ws);
        expect(toggleAction(bookmark, Ws, false)).toEqual({ kind: "removeEverywhere" });
    });
});

describe("the place finder (mockup 2 ter)", () => {
    const recent = ["workspace:w2", "project:w1/p2", "workspace:gone", "app"];

    it("lists, with nothing typed, the places near here and then the recent ones not already listed", () => {
        const { bookmark } = bookmarkAt(Ws);
        const items = finderItems(catalog, Here1, bookmark, "", recent);
        expect(items.map((i) => [i.node.name, i.group])).toEqual([
            ["app-mobile", "near"],
            ["Mobile", "near"],
        ]);
    });

    it("lists a recent place that is not near", () => {
        const { bookmark } = bookmarkAt(Ws);
        const items = finderItems(catalog, Here1, bookmark, "", ["context:sefers", "workspace:w2"]);
        expect(items.map((i) => [i.node.name, i.group])).toEqual([
            ["app-mobile", "near"],
            ["Mobile", "near"],
            ["SEFERS", "recent"],
        ]);
    });

    it("finds, with a text typed, places of every kind with the letters to underline, and marks where it already is", () => {
        const { bookmark } = bookmarkAt(P2);
        const items = finderItems(catalog, Here1, bookmark, "mob", recent);
        expect(items.every((i) => i.group === "results")).toBe(true);
        const names = items.map((i) => i.node.name);
        expect(names).toEqual(["Mobile", "app-mobile"]);
        expect(items[0].positions).toEqual([0, 1, 2]);
        expect(items.map((i) => i.there)).toEqual([false, true]);
    });

    it("moves with the arrow keys, wrapping, and jumps with Home and End", () => {
        expect(nextFinderIndex("ArrowDown", 0, 3)).toBe(1);
        expect(nextFinderIndex("ArrowDown", 2, 3)).toBe(0);
        expect(nextFinderIndex("ArrowUp", 0, 3)).toBe(2);
        expect(nextFinderIndex("ArrowUp", 2, 3)).toBe(1);
        expect(nextFinderIndex("Home", 2, 3)).toBe(0);
        expect(nextFinderIndex("End", 0, 3)).toBe(2);
        expect(nextFinderIndex("ArrowDown", -1, 3)).toBe(0);
        expect(nextFinderIndex("a", 0, 3)).toBe(-1);
        expect(nextFinderIndex("ArrowDown", 0, 0)).toBe(-1);
    });
});
