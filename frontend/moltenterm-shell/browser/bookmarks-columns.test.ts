// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { buildCatalog, type CatalogWorkspace } from "./bookmark-places";
import {
    AppSelection,
    chooseFolder,
    chooseNode,
    columnCapacity,
    dropAction,
    levelHeadingKey,
    MaxColumns,
    panelColumns,
    pathCrumbs,
    searchBookmarks,
    selectionOfHere,
    selectionOfPlace,
    selectionUp,
    shrinkCrumbs,
    visibleColumns,
    type Column,
    type PanelSelection,
} from "./bookmarks-columns";
import {
    addBookmark,
    BookmarkStore,
    createFolder,
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
const Mobile: PlaceRef = { level: LevelWorkspace, id: "w2" };
const P1: PlaceRef = { level: LevelProject, id: projectPlaceId("w1", "p1") };

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
const catalog = buildCatalog({
    appName: "The whole app",
    contexts: [
        { context: { id: "sefers" }, name: "Client: SEFERS" },
        { context: { id: "pro" }, name: "Mes logiciels pro" },
    ],
    workspaces,
});

let counter = 0;
const makeId = (prefix: "b" | "f") => `${prefix}${++counter}`;

function world(): BookmarkStore {
    counter = 0;
    let store = EmptyStore;
    const put = (title: string, url: string, ref: PlaceRef, folder?: string) => {
        const added = addBookmark(store, { url, title, description: "" }, ref, folder ? { newFolder: folder } : {}, makeId);
        if (added.problem != null) {
            throw new Error(added.problem);
        }
        store = added.value.store;
        return added.value.bookmark.id;
    };
    put("Docs", "https://docs.example/", App);
    put("Facturation", "https://billing.example/", Ctx);
    put("Linear", "https://linear.example/", Ws);
    const shared = put("Recette", "https://recette.example/", Ws);
    store = placeBookmark(store, shared, P1, {}, makeId).value;
    put("Dépôt", "https://git.example/", P1, "Environnements");
    return store;
}

const here = (selection: PanelSelection) => panelColumns(world(), catalog, selection, Here1);
const names = (column: Column) =>
    column.items.map((i) => (i.kind === "heading" ? `# ${i.level}` : i.kind === "folder" ? i.folder.name : i.kind === "node" ? i.node.name : i.bookmark.title));

describe("the columns of the panel (mockup 3)", () => {
    it("opens on the current place: one column per level of here, down to the project", () => {
        const selection = selectionOfHere(catalog, Here1);
        expect(selection.path).toEqual([Ctx, Ws, P1]);
        const columns = here(selection);
        expect(columns.map((c) => c.key)).toEqual(["app", "context:sefers", "workspace:w1", `project:${P1.id}`]);
    });

    it("lists a place's folders, then its bookmarks, then its child places under a heading", () => {
        const columns = here(selectionOfHere(catalog, Here1));
        expect(names(columns[0])).toEqual(["Docs", "# context", "Client: SEFERS", "Mes logiciels pro"]);
        expect(names(columns[1])).toEqual(["Facturation", "# workspace", "Échanges", "Mobile"]);
        expect(names(columns[2])).toEqual(["Linear", "Recette", "# project", "site-web", "app-mobile"]);
        expect(names(columns[3])).toEqual(["Environnements", "Recette"]);
    });

    it("marks the chosen item of each column, and the current place with its dot", () => {
        const columns = here(selectionOfHere(catalog, Here1));
        const selected = columns.map((c) => c.items.filter((i) => i.kind === "node" && i.selected).map((i: any) => i.node.name));
        expect(selected).toEqual([["Client: SEFERS"], ["Échanges"], ["site-web"], []]);
        const dots = columns.flatMap((c) => c.items.filter((i) => i.kind === "node" && i.here).map((i: any) => i.node.name));
        expect(dots).toEqual(["Échanges", "site-web"]);
    });

    it("opens a folder in the next column, with its bookmarks only", () => {
        const store = world();
        const folder = store.folders[`project:${P1.id}`][0];
        const columns = panelColumns(store, catalog, { path: [Ctx, Ws, P1], folder: folder.id }, Here1);
        expect(columns).toHaveLength(5);
        expect(columns[4].folder).toBe(folder.id);
        expect(names(columns[4])).toEqual(["Dépôt"]);
        expect(columns[3].items.find((i) => i.kind === "folder" && i.selected)).toBeDefined();
    });

    it("shows only the app's column at first, and the bookmarks of the place a node leads to", () => {
        const columns = here(AppSelection);
        expect(columns).toHaveLength(1);
        const next = here(chooseNode(AppSelection, 0, Ctx));
        expect(next).toHaveLength(2);
        expect(names(next[1])).toEqual(["Facturation", "# workspace", "Échanges", "Mobile"]);
    });

    it("marks a bookmark placed at several places, which the lists give a shortcut mark and a count", () => {
        const columns = here(selectionOfHere(catalog, Here1));
        const recette = columns[2].items.find((i) => i.kind === "bookmark" && i.bookmark.title === "Recette") as any;
        expect(recette.bookmark.places).toHaveLength(2);
        const linear = columns[2].items.find((i) => i.kind === "bookmark" && i.bookmark.title === "Linear") as any;
        expect(linear.bookmark.places).toHaveLength(1);
    });

    it("never offers to create a context, a workspace or a project: children are only listed", () => {
        const items = here(selectionOfHere(catalog, Here1)).flatMap((c) => c.items);
        expect(items.filter((i) => i.kind === "node").every((i: any) => i.node.ref.level !== LevelApp)).toBe(true);
        expect(items.map((i) => i.kind)).not.toContain("create");
    });
});

describe("how many columns show", () => {
    it("is at most three, fewer when the panel is narrow (about 180 px each)", () => {
        expect(MaxColumns).toBe(3);
        expect(columnCapacity(640)).toBe(3);
        expect(columnCapacity(960)).toBe(3);
        expect(columnCapacity(540)).toBe(3);
        expect(columnCapacity(539)).toBe(2);
        expect(columnCapacity(360)).toBe(2);
        expect(columnCapacity(359)).toBe(1);
        expect(columnCapacity(100)).toBe(1);
        expect(columnCapacity(0)).toBe(1);
    });

    it("keeps the last levels, and leaves the higher ones to the path", () => {
        const columns = here(selectionOfHere(catalog, Here1));
        expect(columns).toHaveLength(4);
        expect(visibleColumns(columns, 3).map((c) => c.key)).toEqual([
            "context:sefers",
            "workspace:w1",
            `project:${P1.id}`,
        ]);
        expect(visibleColumns(columns, 2).map((c) => c.key)).toEqual(["workspace:w1", `project:${P1.id}`]);
        expect(visibleColumns(columns, 1).map((c) => c.key)).toEqual([`project:${P1.id}`]);
        expect(visibleColumns(columns.slice(0, 2), 3)).toHaveLength(2);
    });
});

describe("the path (mockup 3)", () => {
    const crumbs = (selection: PanelSelection) =>
        pathCrumbs(catalog, selection, (ref, id) => world().folders[`project:${P1.id}`]?.find((f) => f.id === id)?.name ?? "");

    it("names the app, each chosen place, then the open folder, each leading back to its level", () => {
        const folder = world().folders[`project:${P1.id}`][0];
        const list = crumbs({ path: [Ctx, Ws, P1], folder: folder.id });
        expect(list.map((c) => c.name)).toEqual(["The whole app", "Client: SEFERS", "Échanges", "site-web", "Environnements"]);
        expect(list[0].selection).toEqual(AppSelection);
        expect(list[2].selection).toEqual({ path: [Ctx, Ws], folder: "" });
    });

    it("never overflows: it folds in the middle, keeping the first and the last, and says what is hidden", () => {
        const list = crumbs(selectionOfHere(catalog, Here1));
        const fits = shrinkCrumbs(list, 200);
        expect(fits.folded).toBe(false);
        expect(fits.shown.map((c) => c.name)).toEqual(["The whole app", "Client: SEFERS", "Échanges", "site-web"]);
        const tight = shrinkCrumbs(list, 30);
        expect(tight.folded).toBe(true);
        expect(tight.shown.map((c) => c.name)).toEqual(["The whole app", "site-web"]);
        expect(tight.hidden.map((c) => c.name)).toEqual(["Client: SEFERS", "Échanges"]);
        const some = shrinkCrumbs(list, 40);
        expect(some.shown[0].name).toBe("The whole app");
        expect(some.shown[some.shown.length - 1].name).toBe("site-web");
        expect(some.shown.length + some.hidden.length).toBe(list.length);
    });

    it("keeps what it hides in order, so the menu of the hidden levels reads top down", () => {
        const list = crumbs(selectionOfHere(catalog, Here1));
        const { shown, hidden } = shrinkCrumbs(list, 0);
        expect([shown[0], ...hidden, shown[shown.length - 1]].map((c) => c.name)).toEqual(list.map((c) => c.name));
    });

    it("goes up one level at a time: out of the folder, then out of the deepest place", () => {
        expect(selectionUp({ path: [Ctx, Ws], folder: "f1" })).toEqual({ path: [Ctx, Ws], folder: "" });
        expect(selectionUp({ path: [Ctx, Ws], folder: "" })).toEqual({ path: [Ctx], folder: "" });
        expect(selectionUp(AppSelection)).toEqual(AppSelection);
    });

    it("chooses a place or a folder in a column: what is above stays, what is below goes", () => {
        const selection: PanelSelection = { path: [Ctx, Ws, P1], folder: "f1" };
        expect(chooseNode(selection, 1, Mobile)).toEqual({ path: [Ctx, Mobile], folder: "" });
        expect(chooseFolder(selection, 2, "f2")).toEqual({ path: [Ctx, Ws], folder: "f2" });
    });

    it("walks to a place of a bookmark, and into its folder", () => {
        expect(selectionOfPlace(catalog, P1, "f1")).toEqual({ path: [Ctx, Ws, P1], folder: "f1" });
        expect(selectionOfPlace(catalog, App, "")).toEqual(AppSelection);
    });
});

describe("the search replaces the path and covers every bookmark of the app", () => {
    it("finds by title first, then address and note, each with the path of its places", () => {
        const store = world();
        const hits = searchBookmarks(store, catalog, "rec");
        expect(hits.map((h) => h.bookmark.title)).toEqual(["Recette"]);
        expect(hits[0].paths).toEqual(["Client: SEFERS › Échanges", "Client: SEFERS › Échanges › site-web"]);
        const docs = searchBookmarks(store, catalog, "docs");
        expect(docs[0].paths).toEqual(["The whole app"]);
        expect(hits[0].positions).toEqual([0, 1, 2]);
        const byAddress = searchBookmarks(store, catalog, "git.example");
        expect(byAddress.map((h) => h.bookmark.title)).toEqual(["Dépôt"]);
        expect(byAddress[0].paths[0]).toContain("Environnements");
    });

    it("includes bookmarks of another context, which the places here do not show", () => {
        counter = 100;
        const far = addBookmark(
            world(),
            { url: "https://far.example/", title: "Faraway", description: "" },
            { level: LevelContext, id: "pro" },
            {},
            makeId
        ).value.store;
        expect(searchBookmarks(far, catalog, "far").map((h) => h.bookmark.title)).toEqual(["Faraway"]);
    });

    it("lists nothing for an empty search, and ranks a title above an address", () => {
        expect(searchBookmarks(world(), catalog, "  ")).toEqual([]);
        counter = 200;
        const store = addBookmark(
            world(),
            { url: "https://x.example/docs-in-address", title: "Zebra", description: "" },
            App,
            {},
            makeId
        ).value.store;
        expect(searchBookmarks(store, catalog, "docs").map((h) => h.bookmark.title)).toEqual(["Docs", "Zebra"]);
    });
});

describe("dragging a bookmark (mockup 3)", () => {
    it("moves it from the place it was dragged out of to the place it is dropped on", () => {
        const store = world();
        const linear = store.records.find((b) => b.title === "Linear");
        expect(dropAction(store, { id: linear.id, from: Ws }, { ref: Mobile, folder: "" }, false)).toEqual({
            kind: "move",
            id: linear.id,
            from: Ws,
            to: Mobile,
            folder: "",
        });
    });

    it("places it there too, as a shortcut, with Alt held", () => {
        const store = world();
        const linear = store.records.find((b) => b.title === "Linear");
        expect(dropAction(store, { id: linear.id, from: Ws }, { ref: App, folder: "" }, true)).toEqual({
            kind: "place",
            id: linear.id,
            to: App,
            folder: "",
        });
    });

    it("moves it into a folder, and does nothing when it is dropped where it already is", () => {
        const store = world();
        const folder = store.folders[`project:${P1.id}`][0].id;
        const recette = store.records.find((b) => b.title === "Recette");
        expect(dropAction(store, { id: recette.id, from: Ws }, { ref: P1, folder }, false)).toMatchObject({
            kind: "move",
            to: P1,
            folder,
        });
        expect(dropAction(store, { id: recette.id, from: Ws }, { ref: Ws, folder: "" }, false)).toEqual({ kind: "none" });
        expect(dropAction(store, { id: recette.id, from: Ws }, { ref: Ws, folder: "" }, true)).toEqual({ kind: "none" });
        expect(dropAction(store, { id: "gone", from: Ws }, { ref: App, folder: "" }, false)).toEqual({ kind: "none" });
    });

    it("moves a bookmark between folders of the same place", () => {
        let store = world();
        store = createFolder(store, Ws, "Docs", makeId).value.store;
        const folder = store.folders["workspace:w1"][0].id;
        const linear = store.records.find((b) => b.title === "Linear");
        expect(dropAction(store, { id: linear.id, from: Ws }, { ref: Ws, folder }, false)).toMatchObject({
            kind: "move",
            from: Ws,
            to: Ws,
            folder,
        });
    });
});

describe("the headings of a column", () => {
    it("name the kind of place listed under them", () => {
        expect(levelHeadingKey(LevelContext)).toBe("browser.bookmarks.panel.contexts");
        expect(levelHeadingKey(LevelWorkspace)).toBe("browser.bookmarks.panel.workspaces");
        expect(levelHeadingKey(LevelProject)).toBe("browser.bookmarks.panel.projects");
    });
});
