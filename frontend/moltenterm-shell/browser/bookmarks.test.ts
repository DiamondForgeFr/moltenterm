// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from "vitest";
import {
    addBookmark,
    addPage,
    Bookmark,
    bookmarkablePage,
    bookmarkAddress,
    BookmarkLimits,
    BookmarksMetaKey,
    BookmarkStore,
    bookmarksAt,
    copyBookmarkTo,
    countAt,
    createFolder,
    deleteBookmark,
    deleteFolder,
    EmptyStore,
    findByAddress,
    findVisibleByAddress,
    foldersAt,
    Here,
    hereOf,
    LevelApp,
    LevelContext,
    LevelProject,
    LevelWorkspace,
    moveBookmark,
    pageState,
    parsePlaceKey,
    placeBookmark,
    PlaceRef,
    placeKey,
    plainText,
    problemMessage,
    projectIdOfTab,
    projectPlaceId,
    readStore,
    refsHere,
    renameFolder,
    sameBookmarkAddress,
    singleLine,
    splitProjectPlaceId,
    storeValue,
    unplaceBookmark,
    updateBookmark,
    visibleFrom,
    visiblePlaces,
} from "./bookmarks";

// Ids in the order they are asked, so a test reads what it made; the counter restarts with each test.
let counter = 0;
beforeEach(() => {
    counter = 0;
});
function ids() {
    return (prefix: "b" | "f") => `${prefix}${++counter}`;
}

const App: PlaceRef = { level: LevelApp, id: "" };
const Ctx: PlaceRef = { level: LevelContext, id: "ctx1" };
const OtherCtx: PlaceRef = { level: LevelContext, id: "ctx2" };
const Ws: PlaceRef = { level: LevelWorkspace, id: "w1" };
const OtherWs: PlaceRef = { level: LevelWorkspace, id: "w2" };
const P1: PlaceRef = { level: LevelProject, id: projectPlaceId("w1", "p1") };
// The same project id in another workspace: project ids repeat from one workspace to the next.
const OtherP1: PlaceRef = { level: LevelProject, id: projectPlaceId("w2", "p1") };

const Here1: Here = { contextId: "ctx1", workspaceId: "w1", projectId: "p1" };

const draft = (extra: Partial<{ url: string; title: string; description: string }> = {}) => ({
    url: "https://vite.dev/config/",
    title: "Vite config",
    description: "",
    ...extra,
});

function value<T>(result: { value?: T; problem?: string }): T {
    if (result.problem != null) {
        throw new Error(result.problem);
    }
    return result.value;
}

function add(store: BookmarkStore, ref: PlaceRef, extra = {}, makeId = ids()) {
    return value(addBookmark(store, draft(extra), ref, {}, makeId));
}

function place(store: BookmarkStore, id: string, ref: PlaceRef, choice = {}) {
    return value(placeBookmark(store, id, ref, choice, ids()));
}

describe("bookmarkAddress", () => {
    it("keeps http and https addresses and gives a bare host https, a local server http", () => {
        expect(bookmarkAddress("https://vite.dev/config/").value).toBe("https://vite.dev/config/");
        expect(bookmarkAddress("  vite.dev/config  ").value).toBe("https://vite.dev/config");
        expect(bookmarkAddress("localhost:3000").value).toBe("http://localhost:3000/");
        expect(bookmarkAddress("127.0.0.1:8080/health").value).toBe("http://127.0.0.1:8080/health");
        expect(bookmarkAddress("HTTP://Example.com").value).toBe("http://example.com/");
    });

    it("refuses what is not a web address, with the reason", () => {
        expect(bookmarkAddress("").problem).toBe("browser.bookmarks.problem.noAddress");
        expect(bookmarkAddress("   ").problem).toBe("browser.bookmarks.problem.noAddress");
        for (const unsafe of [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<b>x</b>",
            "ftp://example.com/",
            "vscode://open",
            "about:blank",
            "mailto:me@example.com",
        ]) {
            expect(bookmarkAddress(unsafe).problem, unsafe).toBe("browser.bookmarks.problem.notWeb");
        }
        expect(bookmarkAddress("just some words").problem).toBe("browser.bookmarks.problem.notAddress");
    });

    it("refuses a user name or a password in the address, and one that is too long", () => {
        expect(bookmarkAddress("https://user:secret@example.com/").problem).toBe(
            "browser.bookmarks.problem.credentials"
        );
        expect(bookmarkAddress("https://user@example.com/").problem).toBe("browser.bookmarks.problem.credentials");
        const long = "https://example.com/" + "a".repeat(BookmarkLimits.url);
        expect(bookmarkAddress(long).problem).toBe("browser.bookmarks.problem.addressTooLong");
    });

    it("tells the pages a panel can bookmark, and still offers one whose address cannot be kept", () => {
        expect(bookmarkablePage("https://example.com/a")).toBe("https://example.com/a");
        expect(bookmarkablePage("about:blank#moltenterm-start")).toBe("");
        expect(bookmarkablePage("")).toBe("");
        expect(bookmarkablePage(undefined)).toBe("");
        expect(bookmarkablePage("file:///tmp/page.html")).toBe("");
        const long = "https://example.com/" + "a".repeat(BookmarkLimits.url);
        expect(bookmarkablePage(long)).toBe(long);
        const withPassword = "https://user:secret@example.com/";
        expect(bookmarkablePage(withPassword)).toBe(withPassword);
    });

    it("says a problem with its numbers", () => {
        const say = (key: string, vars?: Record<string, string | number>) => `${key}|${JSON.stringify(vars)}`;
        expect(problemMessage("browser.bookmarks.problem.tooMany", say)).toBe(
            `browser.bookmarks.problem.tooMany|{"max":${BookmarkLimits.items}}`
        );
        expect(problemMessage("browser.bookmarks.problem.tooManyPlaces", say)).toBe(
            `browser.bookmarks.problem.tooManyPlaces|{"max":${BookmarkLimits.places}}`
        );
    });

    it("takes a fragment or a lone trailing slash for the same page", () => {
        expect(sameBookmarkAddress("https://example.com/a/", "https://example.com/a#top")).toBe(true);
        expect(sameBookmarkAddress("https://example.com", "https://example.com/")).toBe(true);
        expect(sameBookmarkAddress("https://example.com/a?x=1", "https://example.com/a?x=2")).toBe(false);
        expect(sameBookmarkAddress("", "")).toBe(false);
    });

    it("flattens a title to one line and removes control characters", () => {
        expect(singleLine("  Vite \n config\t ")).toBe("Vite config");
        expect(plainText("a\u0007b\u001b[31mc")).toBe("ab[31mc");
    });
});

describe("the places of a bookmark (FR-BRW-019, #2531)", () => {
    it("names each level by its key, and a project by its workspace and its own id", () => {
        expect(placeKey(App)).toBe("app");
        expect(placeKey(Ctx)).toBe("context:ctx1");
        expect(placeKey(Ws)).toBe("workspace:w1");
        expect(placeKey(P1)).toBe("project:w1/p1");
        for (const ref of [App, Ctx, Ws, P1]) {
            expect(parsePlaceKey(placeKey(ref))).toEqual(ref);
        }
        expect(parsePlaceKey("nonsense")).toBeNull();
        expect(parsePlaceKey("project:")).toBeNull();
        expect(parsePlaceKey("galaxy:x")).toBeNull();
        expect(splitProjectPlaceId(P1.id)).toEqual({ workspaceId: "w1", projectId: "p1" });
    });

    it("keeps the project of one workspace apart from the same project id of another", () => {
        expect(placeKey(P1)).not.toBe(placeKey(OtherP1));
    });

    it("lists the places of here, widest first, without a project when none is linked", () => {
        expect(refsHere(Here1)).toEqual([App, Ctx, Ws, P1]);
        expect(refsHere({ ...Here1, projectId: null })).toEqual([App, Ctx, Ws]);
    });

    it("finds the here of a panel's tab: its context, its workspace and its tab's project", () => {
        const ws = {
            oid: "w1",
            meta: {
                "molten:projects": [
                    { id: "p1", type: "Desktop", dir: "/work/app" },
                    { id: "p2", type: "Website", dir: "/work/site" },
                ],
                "molten:currentproject": "p1",
                "molten:project": "/work/app",
                "molten:projecttype": "Desktop",
                "molten:context": "ctx2",
                "molten:tabprojects": { tabB: "p2", tabGone: "p9" },
            },
        };
        const contexts = [{ id: "ctx1" }, { id: "ctx2" }];
        expect(projectIdOfTab(ws, "tabA")).toBe("p1");
        expect(projectIdOfTab(ws, "tabB")).toBe("p2");
        expect(projectIdOfTab(ws, "tabGone")).toBe("p1");
        expect(hereOf(ws, contexts, "tabB")).toEqual({ contextId: "ctx2", workspaceId: "w1", projectId: "p2" });
        expect(hereOf({ oid: "w3", meta: {} }, contexts, "t")).toEqual({
            contextId: "ctx1",
            workspaceId: "w3",
            projectId: null,
        });
    });
});

describe("addBookmark", () => {
    it("adds a bookmark with one place outside any folder, titled from the page or from its host", () => {
        const { store, bookmark } = add(EmptyStore, P1, { description: "The build options." });
        expect(store.records).toEqual([bookmark]);
        expect(bookmark).toEqual({
            id: "b1",
            url: "https://vite.dev/config/",
            title: "Vite config",
            description: "The build options.",
            places: [{ level: LevelProject, id: P1.id, folder: "" }],
        });
        expect(add(EmptyStore, Ws, { title: "  " }).bookmark.title).toBe("vite.dev");
    });

    it("puts it in a folder of the place, or creates the folder by name and reuses one of that name", () => {
        const makeId = ids();
        const first = value(addBookmark(EmptyStore, draft(), Ws, { newFolder: "Docs" }, makeId));
        expect(foldersAt(first.store, Ws).map((f) => f.name)).toEqual(["Docs"]);
        expect(first.bookmark.places[0].folder).toBe(foldersAt(first.store, Ws)[0].id);
        const second = value(
            addBookmark(first.store, draft({ url: "https://a.example/" }), Ws, { newFolder: " docs " }, makeId)
        );
        expect(foldersAt(second.store, Ws)).toHaveLength(1);
        expect(second.bookmark.places[0].folder).toBe(first.bookmark.places[0].folder);
        const known = value(
            addBookmark(second.store, draft({ url: "https://b.example/" }), Ws, { folder: "nope" }, makeId)
        );
        expect(known.bookmark.places[0].folder).toBe("");
    });

    it("refuses a second bookmark with the same address at the same place, whatever its fragment", () => {
        const { store } = add(EmptyStore, P1);
        expect(addBookmark(store, draft({ url: "https://vite.dev/config#top" }), P1).problem).toBe(
            "browser.bookmarks.problem.alreadyThere"
        );
        // Another place may hold the same address: it is another bookmark there.
        expect(addBookmark(store, draft(), Ws).problem).toBeUndefined();
    });

    it("keeps to the limits and says which one", () => {
        let store = EmptyStore;
        for (let i = 0; i < BookmarkLimits.items; i++) {
            store = value(addBookmark(store, draft({ url: `https://a.example/${i}` }), Ws, {}, ids())).store;
        }
        expect(addBookmark(store, draft({ url: "https://a.example/one-more" }), Ws).problem).toBe(
            "browser.bookmarks.problem.tooMany"
        );
        // The limit is per place.
        expect(addBookmark(store, draft({ url: "https://a.example/one-more" }), P1).problem).toBeUndefined();
        expect(addBookmark(EmptyStore, draft({ title: "t".repeat(BookmarkLimits.title + 1) }), Ws).problem).toBe(
            "browser.bookmarks.problem.titleTooLong"
        );
        expect(
            addBookmark(EmptyStore, draft({ description: "d".repeat(BookmarkLimits.description + 1) }), Ws).problem
        ).toBe("browser.bookmarks.problem.descriptionTooLong");
        expect(addBookmark(EmptyStore, draft({ url: "ftp://x.example/" }), Ws).problem).toBe(
            "browser.bookmarks.problem.notWeb"
        );
    });

    it("keeps no more than the app's limit of bookmarks", () => {
        const full: BookmarkStore = {
            folders: {},
            records: Array.from({ length: BookmarkLimits.records }, (_, i) => ({
                id: `b${i}`,
                url: `https://a.example/${i}`,
                title: "t",
                description: "",
                places: [{ ...App, folder: "" }],
            })),
        };
        expect(addBookmark(full, draft({ url: "https://z.example/" }), Ws).problem).toBe(
            "browser.bookmarks.problem.tooManyBookmarks"
        );
    });

    it("cleans control characters and flattens a title to one line, but keeps a note's lines", () => {
        const { bookmark } = add(EmptyStore, Ws, { title: "A\n\tB\u0007", description: "line 1\nline 2\u001b" });
        expect(bookmark.title).toBe("A B");
        expect(bookmark.description).toBe("line 1\nline 2");
    });
});

describe("one bookmark, several places", () => {
    it("places the same record at another place: its text is the same everywhere, each place has its own folder", () => {
        const first = add(EmptyStore, P1, { description: "note" });
        const withFolder = value(createFolder(first.store, Ws, "Environments", ids()));
        const folder = withFolder.folder.id;
        const placed = place(withFolder.store, first.bookmark.id, Ws, { folder });
        expect(placed.records).toHaveLength(1);
        const [b] = placed.records;
        expect(b.places).toEqual([
            { level: LevelProject, id: P1.id, folder: "" },
            { level: LevelWorkspace, id: "w1", folder },
        ]);
        expect(bookmarksAt(placed, P1, "")).toEqual([b]);
        expect(bookmarksAt(placed, Ws, folder)).toEqual([b]);
        expect(bookmarksAt(placed, Ws, "")).toEqual([]);
    });

    it("renames it everywhere with one change, and changes its note everywhere", () => {
        const first = add(EmptyStore, P1);
        const shared = place(place(first.store, "b1", Ws), "b1", App);
        const renamed = value(updateBookmark(shared, "b1", draft({ title: "Renamed", description: "New note" })));
        for (const ref of [P1, Ws, App]) {
            const [only] = bookmarksAt(renamed, ref);
            expect(only).toMatchObject({ id: "b1", title: "Renamed", description: "New note" });
        }
        expect(renamed.records).toHaveLength(1);
    });

    it("refuses to change its address onto another bookmark's address at one of its places", () => {
        const a = add(EmptyStore, Ws);
        const b = value(addBookmark(a.store, draft({ url: "https://other.example/" }), Ws, {}, ids()));
        expect(updateBookmark(b.store, b.bookmark.id, draft({ url: "https://vite.dev/config/" })).problem).toBe(
            "browser.bookmarks.problem.alreadyThere"
        );
    });

    it("moves it to another folder of a place it already has, and refuses an address the new place holds", () => {
        const { store } = add(EmptyStore, Ws);
        const withFolder = value(createFolder(store, Ws, "Docs", ids()));
        const moved = place(withFolder.store, "b1", Ws, { folder: withFolder.folder.id });
        expect(moved.records[0].places).toEqual([{ level: LevelWorkspace, id: "w1", folder: withFolder.folder.id }]);
        expect(moved.records).toHaveLength(1);
        const twin = value(addBookmark(moved, draft({ title: "Twin" }), P1, {}, ids())).store;
        expect(placeBookmark(twin, "b1", P1).problem).toBe("browser.bookmarks.problem.alreadyThere");
    });

    it("holds no more places than the limit", () => {
        let store = add(EmptyStore, App).store;
        for (let i = 1; i < BookmarkLimits.places; i++) {
            store = place(store, "b1", { level: LevelWorkspace, id: `w${i}` });
        }
        expect(placeBookmark(store, "b1", { level: LevelWorkspace, id: "overflow" }).problem).toBe(
            "browser.bookmarks.problem.tooManyPlaces"
        );
    });

    it("removes it from one place only, and deletes it when its last place goes", () => {
        const first = add(EmptyStore, P1);
        const shared = place(first.store, "b1", Ws);
        const fromProject = unplaceBookmark(shared, "b1", P1);
        expect(fromProject.records[0].places).toEqual([{ level: LevelWorkspace, id: "w1", folder: "" }]);
        expect(unplaceBookmark(fromProject, "b1", Ws).records).toEqual([]);
        // A place it is not at changes nothing.
        expect(unplaceBookmark(shared, "b1", App)).toBe(shared);
    });

    it("deletes it everywhere in one go, and only it", () => {
        const first = add(EmptyStore, P1);
        const other = value(addBookmark(first.store, draft({ url: "https://b.example/" }), P1, {}, ids()));
        const shared = place(other.store, "b1", Ws);
        const left = deleteBookmark(shared, "b1");
        expect(left.records.map((b) => b.url)).toEqual(["https://b.example/"]);
        expect(bookmarksAt(left, Ws)).toEqual([]);
    });

    it("moves it from one place to another, keeping its other places", () => {
        const first = add(EmptyStore, P1);
        const shared = place(first.store, "b1", App);
        const moved = value(moveBookmark(shared, "b1", P1, Ws, {}, ids()));
        expect(moved.records[0].places).toEqual([
            { level: LevelApp, id: "", folder: "" },
            { level: LevelWorkspace, id: "w1", folder: "" },
        ]);
        expect(moveBookmark(shared, "b1", Ctx, Ws).problem).toBe("browser.bookmarks.problem.gone");
        // Onto the place it is already at, it only changes folder.
        const withFolder = value(createFolder(shared, App, "Docs", ids()));
        const inFolder = value(moveBookmark(withFolder.store, "b1", App, App, { folder: withFolder.folder.id }, ids()));
        expect(inFolder.records[0].places.find((p) => p.level === LevelApp).folder).toBe(withFolder.folder.id);
    });

    it("makes a separate copy with its own name, refused where the original sits already", () => {
        const first = add(EmptyStore, P1, { description: "note" });
        const copy = value(copyBookmarkTo(first.store, "b1", Ws, {}, ids()));
        expect(copy.bookmark.id).not.toBe("b1");
        expect(copy.store.records).toHaveLength(2);
        const renamed = value(updateBookmark(copy.store, copy.bookmark.id, draft({ title: "Mine" })));
        expect(renamed.records.find((b) => b.id === "b1").title).toBe("Vite config");
        expect(copyBookmarkTo(first.store, "b1", P1).problem).toBe("browser.bookmarks.problem.alreadyThere");
        expect(copyBookmarkTo(first.store, "nope", Ws).problem).toBe("browser.bookmarks.problem.gone");
    });

    it("counts what a place holds", () => {
        const first = add(EmptyStore, P1);
        const shared = place(first.store, "b1", Ws);
        expect([countAt(shared, P1), countAt(shared, Ws), countAt(shared, App)]).toEqual([1, 1, 0]);
    });
});

describe("visibility from a place", () => {
    function world() {
        let store = EmptyStore;
        const makeId = ids();
        const put = (title: string, url: string, ref: PlaceRef) => {
            store = value(addBookmark(store, { url, title, description: "" }, ref, {}, makeId)).store;
        };
        put("App wide", "https://app.example/", App);
        put("This context", "https://ctx.example/", Ctx);
        put("Another context", "https://ctx2.example/", OtherCtx);
        put("This workspace", "https://ws.example/", Ws);
        put("Another workspace", "https://ws2.example/", OtherWs);
        put("This project", "https://p1.example/", P1);
        put("Same project id elsewhere", "https://op1.example/", OtherP1);
        return store;
    }

    it("shows those of its app, its context, its workspace and its project, and no others", () => {
        const titles = visibleFrom(world(), Here1).map((b) => b.title);
        expect(titles).toEqual(["App wide", "This context", "This workspace", "This project"]);
    });

    it("shows a bookmark of the context from every workspace of that context, and not from another context", () => {
        const store = world();
        const sibling: Here = { contextId: "ctx1", workspaceId: "w9", projectId: null };
        expect(visibleFrom(store, sibling).map((b) => b.title)).toEqual(["App wide", "This context"]);
        const elsewhere: Here = { contextId: "ctx2", workspaceId: "w2", projectId: "p1" };
        const seen = visibleFrom(store, elsewhere).map((b) => b.title);
        expect(seen).toEqual(["App wide", "Another context", "Another workspace", "Same project id elsewhere"]);
        expect(seen).not.toContain("This context");
    });

    it("works from a workspace with no project: its project's bookmarks are not shown", () => {
        const none: Here = { ...Here1, projectId: null };
        expect(visibleFrom(world(), none).map((b) => b.title)).toEqual(["App wide", "This context", "This workspace"]);
    });

    it("lists a bookmark once however many visible places it has, and tells which places are visible", () => {
        const store = place(place(add(EmptyStore, P1).store, "b1", Ws), "b1", OtherWs);
        expect(visibleFrom(store, Here1)).toHaveLength(1);
        expect(visiblePlaces(store.records[0], Here1).map(placeKey)).toEqual(["project:w1/p1", "workspace:w1"]);
    });
});

describe("the add button's state for a page", () => {
    it("is filled for a page that is a bookmark at a place visible from here", () => {
        const store = add(EmptyStore, Ws).store;
        const state = pageState(store, Here1, "https://vite.dev/config#anchor");
        expect(state.kind).toBe("here");
        expect(findVisibleByAddress(store, Here1, "https://vite.dev/config/")?.id).toBe("b1");
    });

    it("is empty for a page bookmarked only at places that are not visible from here, and says where it is", () => {
        const store = add(EmptyStore, OtherP1).store;
        expect(pageState(store, Here1, "https://vite.dev/config/")).toMatchObject({
            kind: "elsewhere",
            bookmark: { id: "b1" },
        });
        expect(findVisibleByAddress(store, Here1, "https://vite.dev/config/")).toBeNull();
        expect(findByAddress(store, "https://vite.dev/config/")?.id).toBe("b1");
    });

    it("is empty for a page that is a bookmark nowhere", () => {
        expect(pageState(add(EmptyStore, Ws).store, Here1, "https://other.example/")).toEqual({ kind: "none" });
    });

    it("turns filled once the page is placed here too, and empty once it is removed from the visible places", () => {
        const store = add(EmptyStore, OtherP1).store;
        const placed = place(store, "b1", P1);
        expect(pageState(placed, Here1, "https://vite.dev/config/").kind).toBe("here");
        expect(pageState(unplaceBookmark(placed, "b1", P1), Here1, "https://vite.dev/config/").kind).toBe("elsewhere");
    });
});

describe("addPage (the panel's Add the page)", () => {
    it("makes a new bookmark when the page is a bookmark nowhere", () => {
        const added = value(addPage(EmptyStore, draft(), Ws, {}, ids()));
        expect(added.store.records).toHaveLength(1);
    });

    it("places the existing bookmark here instead of making a second one", () => {
        const first = add(EmptyStore, OtherP1);
        const added = value(addPage(first.store, draft(), P1, {}, ids()));
        expect(added.store.records).toHaveLength(1);
        expect(added.bookmark.id).toBe("b1");
        expect(added.store.records[0].places.map(placeKey)).toEqual(["project:w2/p1", "project:w1/p1"]);
    });

    it("refuses a page the place holds already", () => {
        const first = add(EmptyStore, P1);
        expect(addPage(first.store, draft(), P1).problem).toBe("browser.bookmarks.problem.alreadyThere");
    });
});

describe("folders, one list per place", () => {
    it("are named uniquely at a place, case ignored, and the same name may exist at another place", () => {
        const first = value(createFolder(EmptyStore, Ws, "Docs", ids()));
        expect(createFolder(first.store, Ws, "docs").problem).toBe("browser.bookmarks.problem.folderTaken");
        expect(createFolder(first.store, Ws, "  ").problem).toBe("browser.bookmarks.problem.noFolderName");
        expect(createFolder(first.store, Ws, "x".repeat(BookmarkLimits.folderName + 1)).problem).toBe(
            "browser.bookmarks.problem.folderNameTooLong"
        );
        expect(createFolder(first.store, P1, "Docs").problem).toBeUndefined();
        let store = EmptyStore;
        for (let i = 0; i < BookmarkLimits.folders; i++) {
            store = value(createFolder(store, Ws, `f${i}`, ids())).store;
        }
        expect(createFolder(store, Ws, "one more").problem).toBe("browser.bookmarks.problem.tooManyFolders");
    });

    it("rename, keeping the bookmarks in them", () => {
        const withFolder = value(createFolder(add(EmptyStore, Ws).store, Ws, "Docs", ids()));
        const placed = place(withFolder.store, "b1", Ws, { folder: withFolder.folder.id });
        const renamed = value(renameFolder(placed, Ws, withFolder.folder.id, "Guides"));
        expect(foldersAt(renamed, Ws).map((f) => f.name)).toEqual(["Guides"]);
        expect(bookmarksAt(renamed, Ws, withFolder.folder.id)).toHaveLength(1);
        expect(renameFolder(renamed, Ws, "nope", "x").problem).toBe("browser.bookmarks.problem.gone");
    });

    it("delete without losing a bookmark: they stay at their place, and other places are untouched", () => {
        const withFolder = value(createFolder(add(EmptyStore, Ws).store, Ws, "Docs", ids()));
        const folder = withFolder.folder.id;
        const inFolder = place(place(withFolder.store, "b1", Ws, { folder }), "b1", P1);
        const deleted = deleteFolder(inFolder, Ws, folder);
        expect(foldersAt(deleted, Ws)).toEqual([]);
        expect(deleted.records[0].places).toEqual([
            { level: LevelWorkspace, id: "w1", folder: "" },
            { level: LevelProject, id: P1.id, folder: "" },
        ]);
    });
});

describe("what the client stores", () => {
    const stored = (records: unknown[], folders: unknown = {}) => ({ [BookmarksMetaKey]: { records, folders } });
    const rec = (extra: Record<string, unknown> = {}) => ({
        id: "b1",
        url: "https://vite.dev/config/",
        title: "Vite config",
        description: "",
        places: [{ level: "project", id: "w1/p1", folder: "" }],
        ...extra,
    });

    it("reads back what the store writes, per level, one record with its places", () => {
        const first = add(EmptyStore, P1, { description: "note" });
        const withFolder = value(createFolder(first.store, App, "Shared", ids()));
        const shared = place(place(place(withFolder.store, "b1", Ws), "b1", Ctx), "b1", App, {
            folder: withFolder.folder.id,
        });
        const written = JSON.parse(JSON.stringify(storeValue(shared)));
        const read = readStore({ [BookmarksMetaKey]: written });
        expect(read).toEqual(shared);
        expect(read.records).toHaveLength(1);
        expect(read.records[0].places.map((p) => p.level)).toEqual([
            LevelProject,
            LevelWorkspace,
            LevelContext,
            LevelApp,
        ]);
    });

    it("deletes the key once nothing is kept", () => {
        expect(storeValue(EmptyStore)).toBeNull();
        expect(storeValue(add(EmptyStore, Ws).store)).not.toBeNull();
    });

    it("reads nothing from a missing or broken key", () => {
        for (const meta of [null, {}, { [BookmarksMetaKey]: "x" }, { [BookmarksMetaKey]: [] }, stored("x" as any)]) {
            expect(readStore(meta as any), JSON.stringify(meta)).toBe(EmptyStore);
        }
    });

    it("ignores a bookmark whose address is not a safe web address, whoever wrote it", () => {
        const unsafe = ["javascript:alert(1)", "file:///etc/passwd", "https://user:pw@x.example/", "vscode://x", ""];
        const read = readStore(stored([rec(), ...unsafe.map((url, i) => rec({ id: `u${i}`, url }))]));
        expect(read.records.map((b) => b.id)).toEqual(["b1"]);
    });

    it("drops a record with no id, a repeated id or no valid place, and a repeated place", () => {
        const read = readStore(
            stored([
                rec({ id: "" }),
                rec(),
                rec({ url: "https://b.example/" }),
                rec({ id: "b2", url: "https://c.example/", places: [{ level: "galaxy", id: "x", folder: "" }] }),
                rec({ id: "b3", url: "https://d.example/", places: [{ level: "workspace", id: "", folder: "" }] }),
                rec({
                    id: "b4",
                    url: "https://e.example/",
                    places: [
                        { level: "app", id: "ignored", folder: "" },
                        { level: "app", id: "", folder: "" },
                        { level: "workspace", id: "w1", folder: "" },
                    ],
                }),
            ])
        );
        expect(read.records.map((b) => b.id)).toEqual(["b1", "b4"]);
        expect(read.records[1].places).toEqual([
            { level: "app", id: "", folder: "" },
            { level: "workspace", id: "w1", folder: "" },
        ]);
    });

    it("reads a folder that does not exist at its place as no folder, and a folder of another place the same", () => {
        const read = readStore(
            stored(
                [
                    rec({
                        places: [
                            { level: "project", id: "w1/p1", folder: "f1" },
                            { level: "workspace", id: "w1", folder: "f1" },
                            { level: "app", id: "", folder: "gone" },
                        ],
                    }),
                ],
                { "project:w1/p1": [{ id: "f1", name: "Docs" }], "bad key": [{ id: "x", name: "y" }] }
            )
        );
        expect(read.records[0].places.map((p) => p.folder)).toEqual(["f1", "", ""]);
        expect(Object.keys(read.folders)).toEqual(["project:w1/p1"]);
    });

    it("cuts what is read to the limits: texts, folders, places and bookmarks of a place", () => {
        const long = readStore(
            stored([rec({ title: "t".repeat(BookmarkLimits.title + 50), description: "d".repeat(2000) })], {
                "project:w1/p1": Array.from({ length: BookmarkLimits.folders + 5 }, (_, i) => ({
                    id: `f${i}`,
                    name: "n".repeat(100),
                })),
            })
        );
        expect(long.records[0].title).toHaveLength(BookmarkLimits.title);
        expect(long.records[0].description).toHaveLength(BookmarkLimits.description);
        expect(long.folders["project:w1/p1"]).toHaveLength(BookmarkLimits.folders);
        expect(long.folders["project:w1/p1"][0].name).toHaveLength(BookmarkLimits.folderName);

        const crowded = readStore(
            stored(
                Array.from({ length: BookmarkLimits.items + 20 }, (_, i) =>
                    rec({
                        id: `b${i}`,
                        url: `https://a.example/${i}`,
                        places: [{ level: "workspace", id: "w1", folder: "" }],
                    })
                )
            )
        );
        expect(crowded.records).toHaveLength(BookmarkLimits.items);

        const manyPlaces = readStore(
            stored([
                rec({
                    places: Array.from({ length: BookmarkLimits.places + 8 }, (_, i) => ({
                        level: "workspace",
                        id: `w${i}`,
                        folder: "",
                    })),
                }),
            ])
        );
        expect(manyPlaces.records[0].places).toHaveLength(BookmarkLimits.places);
    });

    it("titles a bookmark with its address when the title is missing", () => {
        const read = readStore(stored([rec({ title: 7 })]));
        expect(read.records[0].title).toBe("https://vite.dev/config/");
    });
});

describe("migration of the project bookmarks of a workspace (Go: pkg/molten/bookmarks)", () => {
    it("reads what wavesrv writes for a migrated project bookmark: one record, one project place, its folder", () => {
        const migrated = {
            [BookmarksMetaKey]: {
                records: [
                    {
                        id: "b-12ab34cd",
                        url: "https://vite.dev/config/",
                        title: "Vite config",
                        description: "The build options.",
                        places: [{ level: "project", id: "w1/p1", folder: "f-aaaa1111" }],
                    },
                ],
                folders: { "project:w1/p1": [{ id: "f-aaaa1111", name: "Docs" }] },
            },
        };
        const read = readStore(migrated);
        expect(read.records).toHaveLength(1);
        expect(visibleFrom(read, Here1)).toHaveLength(1);
        expect(visibleFrom(read, { ...Here1, projectId: "p2" })).toHaveLength(0);
        expect(bookmarksAt(read, P1, "f-aaaa1111")).toHaveLength(1);
        expect(foldersAt(read, P1).map((f) => f.name)).toEqual(["Docs"]);
        expect(BookmarkLimits).toMatchObject({ items: 300, folders: 50, title: 200, url: 2048, description: 1000 });
    });
});

describe("the whole story from a panel in a workspace with no project", () => {
    it("adds at the workspace, places at the context and the app, and sees it from a sibling workspace", () => {
        const none: Here = { contextId: "ctx1", workspaceId: "w1", projectId: null };
        const added = add(EmptyStore, Ws);
        const shared = place(place(added.store, "b1", Ctx), "b1", App);
        expect(visibleFrom(shared, none)).toHaveLength(1);
        const sibling: Here = { contextId: "ctx1", workspaceId: "w7", projectId: null };
        expect(visibleFrom(shared, sibling)).toHaveLength(1);
        const stranger: Here = { contextId: "ctx2", workspaceId: "w8", projectId: null };
        expect(visibleFrom(shared, stranger)).toHaveLength(1);
        const noApp = unplaceBookmark(shared, "b1", App);
        expect(visibleFrom(noApp, stranger)).toHaveLength(0);
        expect(visibleFrom(noApp, sibling)).toHaveLength(1);
    });
});

describe("bookmark records are plain data", () => {
    it("never share structure that a later change could alter", () => {
        const first = add(EmptyStore, Ws);
        const snapshot = JSON.stringify(first.store);
        place(first.store, "b1", P1);
        updateBookmark(first.store, "b1", draft({ title: "Other" }));
        unplaceBookmark(first.store, "b1", Ws);
        const b: Bookmark = first.store.records[0];
        expect(JSON.stringify(first.store)).toBe(snapshot);
        expect(b.places).toHaveLength(1);
    });
});
