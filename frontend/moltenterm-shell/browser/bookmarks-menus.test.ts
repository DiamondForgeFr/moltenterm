// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { t } from "../i18n/i18n";
import { buildCatalog } from "./bookmark-places";
import { bookmarkMenu, columnMenu, folderMenu, placesMenu } from "./bookmarks-menus";
import {
    addBookmark,
    createFolder,
    EmptyStore,
    LevelApp,
    LevelProject,
    LevelWorkspace,
    placeBookmark,
    projectPlaceId,
    type PlaceRef,
} from "./bookmarks";

const App: PlaceRef = { level: LevelApp, id: "" };
const Ws: PlaceRef = { level: LevelWorkspace, id: "w1" };
const P1: PlaceRef = { level: LevelProject, id: projectPlaceId("w1", "p1") };

const catalog = buildCatalog({
    appName: "The whole app",
    contexts: [{ context: { id: "c1" }, name: "SEFERS" }],
    workspaces: [{ id: "w1", name: "Échanges", color: "", contextId: "c1", projects: [{ id: "p1", name: "site-web" }] }],
});

let n = 0;
const makeId = (prefix: "b" | "f") => `${prefix}${++n}`;

function sharedBookmark() {
    const folder = createFolder(EmptyStore, Ws, "Docs", makeId).value;
    const added = addBookmark(folder.store, { url: "https://a.example/", title: "A", description: "" }, Ws, { folder: folder.folder.id }, makeId);
    const store = placeBookmark(added.value.store, added.value.bookmark.id, P1, {}, makeId).value;
    return { store, bookmark: store.records[0] };
}

const labels = (menu: ContextMenuItem[]) => menu.filter((i) => i.type !== "separator").map((i) => i.label);
const actions = () => ({
    edit: vi.fn(),
    go: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    remove: vi.fn(),
    removeEverywhere: vi.fn(),
});

describe("right-click in a column (mockup 3)", () => {
    const hooks = () => ({ newFolder: vi.fn(), addPage: vi.fn(), paste: vi.fn() });

    it("offers New folder here, Add the page here and Paste", () => {
        const a = hooks();
        const menu = columnMenu(t, { canAddPage: true, canPaste: true }, a);
        expect(labels(menu)).toEqual(["New folder here", "Add the page here", "Paste"]);
        menu[0].click();
        menu[1].click();
        menu.find((i) => i.label === "Paste").click();
        expect(a.newFolder).toHaveBeenCalledTimes(1);
        expect(a.addPage).toHaveBeenCalledTimes(1);
        expect(a.paste).toHaveBeenCalledTimes(1);
    });

    it("says why Paste does nothing, under the row, and pastes nothing", () => {
        const a = hooks();
        const menu = columnMenu(t, { canAddPage: true, canPaste: false }, a);
        const paste = menu.find((i) => i.label === "Paste");
        expect(paste.sublabel).toBe("Cut or copy a bookmark first");
        paste.click();
        expect(a.paste).not.toHaveBeenCalled();
    });

    it("leaves Add the page out when the shown page cannot be bookmarked", () => {
        const menu = columnMenu(t, { canAddPage: false, canPaste: true }, hooks());
        expect(labels(menu)).toEqual(["New folder here", "Paste"]);
    });

    it("never offers to create a context, a workspace or a project", () => {
        const shared = sharedBookmark();
        const all = [
            ...columnMenu(t, { canAddPage: true, canPaste: true }, hooks()),
            ...folderMenu(t, { canAddPage: true, canPaste: true }, { addPage: vi.fn(), paste: vi.fn(), rename: vi.fn(), remove: vi.fn() }),
            ...bookmarkMenu(t, shared.bookmark, { catalog, store: shared.store, from: Ws }, actions()),
        ].map((i) => (i.label ?? "").toLowerCase());
        for (const word of ["context", "project", "workspace"]) {
            expect(all.filter((l) => l.includes(word))).toEqual([]);
        }
    });
});

describe("right-click on a folder", () => {
    it("adds the page into it, pastes into it, renames it or deletes it, saying its bookmarks stay", () => {
        const a = { addPage: vi.fn(), paste: vi.fn(), rename: vi.fn(), remove: vi.fn() };
        const menu = folderMenu(t, { canAddPage: true, canPaste: true }, a);
        expect(labels(menu)).toEqual(["Add the page here", "Paste", "Rename the folder", "Delete the folder"]);
        expect(menu.find((i) => i.label === "Delete the folder").sublabel).toBe("Its bookmarks stay at their place");
        menu.find((i) => i.label === "Rename the folder").click();
        menu.find((i) => i.label === "Delete the folder").click();
        expect(a.rename).toHaveBeenCalledTimes(1);
        expect(a.remove).toHaveBeenCalledTimes(1);
    });
});

describe("right-click on a bookmark (mockup 3)", () => {
    it("offers Edit, Places…, Cut, Copy and Remove, and removing everywhere only for a shared bookmark", () => {
        const { store, bookmark } = sharedBookmark();
        const a = actions();
        const menu = bookmarkMenu(t, bookmark, { catalog, store, from: Ws }, a);
        expect(labels(menu)).toEqual(["Edit", "Places…", "Cut", "Copy", "Remove", "Remove everywhere"]);
        for (const label of ["Edit", "Cut", "Copy", "Remove", "Remove everywhere"]) {
            menu.find((i) => i.label === label).click();
        }
        expect(a.edit).toHaveBeenCalledTimes(1);
        expect(a.cut).toHaveBeenCalledTimes(1);
        expect(a.copy).toHaveBeenCalledTimes(1);
        expect(a.remove).toHaveBeenCalledTimes(1);
        expect(a.removeEverywhere).toHaveBeenCalledTimes(1);

        const single = addBookmark(EmptyStore, { url: "https://b.example/", title: "B", description: "" }, Ws, {}, makeId).value;
        const alone = bookmarkMenu(t, single.bookmark, { catalog, store: single.store, from: Ws }, actions());
        expect(labels(alone)).toEqual(["Edit", "Places…", "Cut", "Copy", "Remove"]);
    });

    it("lists the places of the bookmark, with their folder, and walks the panel to the one chosen", () => {
        const { store, bookmark } = sharedBookmark();
        const go = vi.fn();
        const menu = placesMenu(t, bookmark, catalog, store, go, vi.fn());
        expect(labels(menu)).toEqual(["Workspace · Échanges", "Project · site-web", "Edit its places…"]);
        expect(menu[0].sublabel).toBe("Docs");
        menu[1].click();
        expect(go).toHaveBeenCalledWith({
            path: [
                { level: "context", id: "c1" },
                Ws,
                P1,
            ],
            folder: "",
        });
    });

    it("has no cut, copy or remove-here in the results of a search, which have no place to act on", () => {
        const { store, bookmark } = sharedBookmark();
        const menu = bookmarkMenu(t, bookmark, { catalog, store, from: null }, actions());
        expect(labels(menu)).toEqual(["Edit", "Places…", "Remove everywhere"]);
        expect(App.level).toBe("app");
    });
});
