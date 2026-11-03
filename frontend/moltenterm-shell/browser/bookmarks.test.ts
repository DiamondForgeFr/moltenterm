// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    addBookmark,
    AllBookmarks,
    bookmarkablePage,
    bookmarkAddress,
    BookmarkLimits,
    BookmarksMetaKey,
    copyBookmarkTo,
    createFolder,
    deleteBookmark,
    deleteFolder,
    findBookmarkByAddress,
    moveBookmark,
    problemVars,
    ProjectBookmarks,
    projectIdOfTab,
    readProjectBookmarks,
    renameFolder,
    sameBookmarkAddress,
    updateBookmark,
    withProjectsBookmarks,
} from "./bookmarks";

// Ids in the order they are asked, so a test reads what it made.
function ids() {
    let n = 0;
    return (prefix: "b" | "f") => `${prefix}${++n}`;
}

const Empty: ProjectBookmarks = { folders: [], items: [] };

function added(data: ProjectBookmarks, draft: Partial<Parameters<typeof addBookmark>[1]>, makeId = ids()) {
    const result = addBookmark(
        data,
        { url: "https://vite.dev/config/", title: "Vite config", description: "", folder: "", ...draft },
        makeId
    );
    if (result.problem != null) {
        throw new Error(result.problem);
    }
    return result.value;
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

    it("tells the pages a panel can bookmark", () => {
        expect(bookmarkablePage("https://example.com/a")).toBe("https://example.com/a");
        expect(bookmarkablePage("about:blank#moltenterm-start")).toBe("");
        expect(bookmarkablePage("")).toBe("");
        expect(bookmarkablePage(undefined)).toBe("");
    });

    it("takes a fragment or a lone trailing slash for the same page", () => {
        expect(sameBookmarkAddress("https://example.com/a/", "https://example.com/a#top")).toBe(true);
        expect(sameBookmarkAddress("https://example.com", "https://example.com/")).toBe(true);
        expect(sameBookmarkAddress("https://example.com/a?x=1", "https://example.com/a?x=2")).toBe(false);
        expect(sameBookmarkAddress("", "")).toBe(false);
    });
});

describe("addBookmark", () => {
    it("adds a bookmark outside any folder, titled from the page or from its host", () => {
        const { data, bookmark } = added(Empty, { description: "The build options." });
        expect(data.items).toEqual([bookmark]);
        expect(bookmark).toEqual({
            id: "b1",
            url: "https://vite.dev/config/",
            title: "Vite config",
            description: "The build options.",
            folder: "",
        });
        expect(added(Empty, { title: "  " }).bookmark.title).toBe("vite.dev");
    });

    it("puts it in an existing folder, or creates the folder by name and reuses one of that name", () => {
        const makeId = ids();
        const first = added(Empty, { newFolder: "Docs" }, makeId);
        expect(first.data.folders).toEqual([{ id: "f1", name: "Docs" }]);
        expect(first.bookmark.folder).toBe("f1");
        const second = added(first.data, { url: "https://a.example.com", newFolder: " docs " }, makeId);
        expect(second.data.folders).toHaveLength(1);
        expect(second.bookmark.folder).toBe("f1");
        const third = added(second.data, { url: "https://b.example.com", folder: "f1" }, makeId);
        expect(third.bookmark.folder).toBe("f1");
        const unknown = added(third.data, { url: "https://c.example.com", folder: "gone" }, makeId);
        expect(unknown.bookmark.folder).toBe("");
    });

    it("refuses a second bookmark with the same address in the project, whatever its fragment", () => {
        const { data } = added(Empty, {});
        const again = addBookmark(data, {
            url: "https://vite.dev/config/#plugins",
            title: "",
            description: "",
            folder: "",
        });
        expect(again.problem).toBe("browser.bookmarks.problem.alreadyThere");
        expect(findBookmarkByAddress(data, "https://vite.dev/config")?.id).toBe("b1");
    });

    it("keeps to the limits and says which one", () => {
        const draft = { url: "https://example.com/", title: "", description: "", folder: "" };
        expect(addBookmark(Empty, { ...draft, title: "t".repeat(BookmarkLimits.title + 1) }).problem).toBe(
            "browser.bookmarks.problem.titleTooLong"
        );
        expect(addBookmark(Empty, { ...draft, description: "d".repeat(BookmarkLimits.description + 1) }).problem).toBe(
            "browser.bookmarks.problem.descriptionTooLong"
        );
        const full: ProjectBookmarks = {
            folders: [],
            items: Array.from({ length: BookmarkLimits.items }, (_, i) => ({
                id: `b${i}`,
                url: `https://example.com/${i}`,
                title: "t",
                description: "",
                folder: "",
            })),
        };
        expect(addBookmark(full, draft).problem).toBe("browser.bookmarks.problem.tooMany");
        expect(problemVars("browser.bookmarks.problem.tooMany")).toEqual({ max: BookmarkLimits.items });
        const manyFolders: ProjectBookmarks = {
            folders: Array.from({ length: BookmarkLimits.folders }, (_, i) => ({ id: `f${i}`, name: `Folder ${i}` })),
            items: [],
        };
        expect(addBookmark(manyFolders, { ...draft, newFolder: "One more" }).problem).toBe(
            "browser.bookmarks.problem.tooManyFolders"
        );
    });

    it("cleans control characters and flattens a title to one line, but keeps a note's lines", () => {
        const { bookmark } = added(Empty, { title: "Two\nlines\u0007", description: "Line one\nline two\u0000" });
        expect(bookmark.title).toBe("Two lines");
        expect(bookmark.description).toBe("Line one\nline two");
    });
});

describe("updateBookmark and moveBookmark", () => {
    it("edits a bookmark in place, and refuses the address of another one", () => {
        const makeId = ids();
        const one = added(Empty, {}, makeId);
        const two = added(one.data, { url: "https://b.example.com", title: "B" }, makeId);
        const edited = updateBookmark(
            two.data,
            "b1",
            {
                url: "https://vite.dev/guide/",
                title: "Guide",
                description: "Start here",
                folder: "",
                newFolder: "Docs",
            },
            makeId
        );
        expect(edited.problem).toBeUndefined();
        expect(edited.value.items[0]).toMatchObject({
            id: "b1",
            url: "https://vite.dev/guide/",
            title: "Guide",
            description: "Start here",
        });
        expect(edited.value.folders).toHaveLength(1);
        expect(edited.value.items[1]).toEqual(two.data.items[1]);
        const clash = updateBookmark(two.data, "b1", {
            url: "https://b.example.com/",
            title: "",
            description: "",
            folder: "",
        });
        expect(clash.problem).toBe("browser.bookmarks.problem.alreadyThere");
        expect(
            updateBookmark(two.data, "nope", { url: "https://c.example.com", title: "", description: "", folder: "" })
                .problem
        ).toBe("browser.bookmarks.problem.gone");
        const same = updateBookmark(two.data, "b1", {
            url: "https://vite.dev/config/",
            title: "Renamed",
            description: "",
            folder: "",
        });
        expect(same.value.items[0].title).toBe("Renamed");
    });

    it("moves a bookmark between the project and its folders, never to a folder that is not there", () => {
        const withFolder = createFolder(added(Empty, {}).data, "Docs", ids()).value;
        const [folder] = withFolder.folders;
        const moved = moveBookmark(withFolder, "b1", folder.id);
        expect(moved.items[0].folder).toBe(folder.id);
        expect(moveBookmark(moved, "b1", "").items[0].folder).toBe("");
        expect(moveBookmark(moved, "b1", "gone")).toBe(moved);
    });
});

describe("folders", () => {
    it("are named uniquely in a project, case ignored, and one level deep", () => {
        const makeId = ids();
        const one = createFolder(Empty, " Docs ", makeId).value;
        expect(one.folders[0].name).toBe("Docs");
        expect(createFolder(one, "docs", makeId).problem).toBe("browser.bookmarks.problem.folderTaken");
        expect(createFolder(one, "  ", makeId).problem).toBe("browser.bookmarks.problem.noFolderName");
        expect(createFolder(one, "x".repeat(BookmarkLimits.folderName + 1), makeId).problem).toBe(
            "browser.bookmarks.problem.folderNameTooLong"
        );
    });

    it("rename, keeping the bookmarks in them", () => {
        const makeId = ids();
        const { data } = added(Empty, { newFolder: "Docs" }, makeId);
        const renamed = renameFolder(data, "f1", "Reference");
        expect(renamed.value.folders).toEqual([{ id: "f1", name: "Reference" }]);
        expect(renamed.value.items[0].folder).toBe("f1");
        expect(renameFolder(data, "f1", "Docs").problem).toBeUndefined();
        expect(renameFolder(createFolder(data, "Ops", makeId).value, "f1", "ops").problem).toBe(
            "browser.bookmarks.problem.folderTaken"
        );
        expect(renameFolder(data, "gone", "X").problem).toBe("browser.bookmarks.problem.gone");
    });

    it("delete without losing a bookmark: they stay in the project", () => {
        const { data } = added(Empty, { newFolder: "Docs" });
        const after = deleteFolder(data, "f1");
        expect(after.folders).toEqual([]);
        expect(after.items).toHaveLength(1);
        expect(after.items[0].folder).toBe("");
    });
});

describe("deleteBookmark", () => {
    it("removes only that bookmark", () => {
        const makeId = ids();
        const one = added(Empty, {}, makeId);
        const two = added(one.data, { url: "https://b.example.com" }, makeId);
        expect(deleteBookmark(two.data, "b1").items.map((b) => b.id)).toEqual(["b2"]);
    });
});

describe("copyBookmarkTo", () => {
    it("makes an independent copy, in the folder of the same name, created when missing", () => {
        const makeId = ids();
        const a = added(Empty, { description: "Note", newFolder: "Docs" }, makeId);
        const copied = copyBookmarkTo(a.data, a.bookmark.id, Empty, makeId);
        expect(copied.problem).toBeUndefined();
        const b = copied.value;
        expect(b.folders.map((f) => f.name)).toEqual(["Docs"]);
        expect(b.items).toHaveLength(1);
        expect(b.items[0]).toMatchObject({ url: a.bookmark.url, title: a.bookmark.title, description: "Note" });
        expect(b.items[0].id).not.toBe(a.bookmark.id);
        expect(b.items[0].folder).toBe(b.folders[0].id);
        const edited = updateBookmark(b, b.items[0].id, {
            url: a.bookmark.url,
            title: "Changed",
            description: "Other",
            folder: "",
        });
        expect(edited.value.items[0].title).toBe("Changed");
        expect(a.data.items[0].title).toBe("Vite config");
        expect(a.data.items[0].description).toBe("Note");
    });

    it("lands outside folders when the original is, reuses a folder of that name, and refuses a duplicate", () => {
        const makeId = ids();
        const a = added(Empty, {}, makeId);
        const target = createFolder(Empty, "Docs", makeId).value;
        const first = copyBookmarkTo(a.data, "b1", target, makeId);
        expect(first.value.items[0].folder).toBe("");
        expect(copyBookmarkTo(a.data, "b1", first.value, makeId).problem).toBe(
            "browser.bookmarks.problem.alreadyThere"
        );
        expect(copyBookmarkTo(a.data, "gone", target, makeId).problem).toBe("browser.bookmarks.problem.gone");
        const inDocs = added(Empty, { newFolder: "docs" }, makeId);
        expect(copyBookmarkTo(inDocs.data, inDocs.bookmark.id, target, makeId).value.folders).toHaveLength(1);
    });
});

describe("what the workspace stores", () => {
    const meta = {
        [BookmarksMetaKey]: {
            p1: {
                folders: [
                    { id: "f1", name: "Docs" },
                    { id: "f1", name: "Twice" },
                    { id: "", name: "No id" },
                ],
                items: [
                    { id: "b1", url: "https://a.example.com", title: "A", description: " note ", folder: "f1" },
                    { id: "b2", url: "https://b.example.com", folder: "gone" },
                    { id: "b1", url: "https://dup.example.com" },
                    { id: "b3", url: "" },
                    "oops",
                    null,
                ],
            },
            p2: "oops",
        },
    };

    it("reads one project's bookmarks, dropping what is malformed", () => {
        const data = readProjectBookmarks(meta, "p1");
        expect(data.folders).toEqual([{ id: "f1", name: "Docs" }]);
        expect(data.items).toEqual([
            { id: "b1", url: "https://a.example.com", title: "A", description: "note", folder: "f1" },
            { id: "b2", url: "https://b.example.com", title: "https://b.example.com", description: "", folder: "" },
        ]);
        expect(readProjectBookmarks(meta, "p2").items).toEqual([]);
        expect(readProjectBookmarks(meta, "p9").items).toEqual([]);
        expect(readProjectBookmarks({}, "p1").items).toEqual([]);
        expect(readProjectBookmarks(null, "p1").items).toEqual([]);
    });

    it("keeps only the projects the workspace has, and none for an empty project", () => {
        const stored: AllBookmarks = {
            p1: {
                folders: [],
                items: [{ id: "b1", url: "https://a.example.com", title: "A", description: "", folder: "" }],
            },
            p2: {
                folders: [],
                items: [{ id: "b2", url: "https://b.example.com", title: "B", description: "", folder: "" }],
            },
            p3: {
                folders: [],
                items: [{ id: "b3", url: "https://c.example.com", title: "C", description: "", folder: "" }],
            },
        };
        const next = withProjectsBookmarks({ [BookmarksMetaKey]: stored }, { p2: Empty }, ["p1", "p2"]);
        expect(Object.keys(next)).toEqual(["p1"]);
        expect(withProjectsBookmarks({ [BookmarksMetaKey]: stored }, { p1: Empty }, ["p1"])).toBeNull();
        expect(withProjectsBookmarks({}, {}, ["p1"])).toBeNull();
    });

    it("finds a tab's project like wavesrv does: the tab's owner, else the current project", () => {
        const ws = {
            meta: {
                "molten:projects": [
                    { id: "p1", type: "Desktop", dir: "/work/app" },
                    { id: "p2", type: "Website", dir: "/work/site" },
                ],
                "molten:currentproject": "p1",
                "molten:project": "/work/app",
                "molten:projecttype": "Desktop",
                "molten:tabprojects": { "tab-web": "p2", "tab-gone": "p9" },
            },
        };
        expect(projectIdOfTab(ws, "tab-web")).toBe("p2");
        expect(projectIdOfTab(ws, "tab-other")).toBe("p1");
        expect(projectIdOfTab(ws, "tab-gone")).toBe("p1");
        expect(projectIdOfTab(ws, null)).toBe("p1");
        expect(projectIdOfTab({ meta: {} }, "tab-web")).toBeNull();
        expect(projectIdOfTab({ meta: { "molten:project": "/work/app" } }, "tab-x")).toBe("p1");
    });
});
