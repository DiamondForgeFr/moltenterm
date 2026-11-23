// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Folders of views (FR-SHELL-080, #2484): create, add, rename, take out, dissolve, reorder, Clear keeps them, what
// persists and how a folder is named from its content.

import { describe, expect, it } from "vitest";
import {
    addToFolder,
    cleanFolderName,
    closableViews,
    derivedFolderName,
    dissolveFolder,
    dissolveSmall,
    dropOnView,
    dwellDone,
    folderAnchor,
    folderCandidateAt,
    FolderDwellMs,
    folderedViews,
    folderOf,
    folderShownName,
    isPullRequestUrl,
    MaxFolderNameLength,
    moveAfterLast,
    moveInFolder,
    moveRunBefore,
    nextDwell,
    pruneViewFolders,
    readViewFolders,
    renameFolder,
    sameViewFolders,
    shownFolders,
    sidebarItems,
    takeOut,
    ViewFolder,
    ViewFoldersMetaKey,
    viewHasNews,
    viewKindOf,
} from "./view-folders-model";

const folder = (id: string, tabids: string[], name = ""): ViewFolder => ({ id, name, tabids });

describe("reading the folders a workspace keeps", () => {
    it("reads folders from the meta and nothing else", () => {
        expect(readViewFolders(null)).toEqual([]);
        expect(readViewFolders({})).toEqual([]);
        expect(readViewFolders({ [ViewFoldersMetaKey]: "nope" })).toEqual([]);
        expect(
            readViewFolders({
                [ViewFoldersMetaKey]: [
                    { id: "f1", name: " Review ", tabids: ["a", "b", "a", 3, ""] },
                    { id: "f1", name: "dup", tabids: ["c", "d"] },
                    { id: "", tabids: ["e", "f"] },
                    { id: "f2", tabids: "x" },
                    { id: "f3", tabids: ["b", "g", "h"] },
                    null,
                ],
            })
        ).toEqual([folder("f1", ["a", "b"], "Review"), folder("f3", ["g", "h"])]);
    });

    it("keeps a name to its limit, on one line", () => {
        expect(cleanFolderName("  a   b\n c ")).toBe("a b c");
        expect(cleanFolderName("x".repeat(100))).toHaveLength(MaxFolderNameLength);
        expect(cleanFolderName(null)).toBe("");
    });

    it("compares folders by what they hold", () => {
        expect(sameViewFolders([folder("f", ["a", "b"])], [folder("f", ["a", "b"])])).toBe(true);
        expect(sameViewFolders([folder("f", ["a", "b"])], [folder("f", ["b", "a"])])).toBe(false);
        expect(sameViewFolders([folder("f", ["a", "b"])], [folder("f", ["a", "b"], "N")])).toBe(false);
    });
});

describe("the Views list with folders", () => {
    const visible = ["a", "b", "c", "d", "e"];

    it("lists every view as a row when there is no folder", () => {
        expect(sidebarItems(visible, [])).toEqual(visible.map((tabId) => ({ kind: "view", tabId })));
    });

    it("puts a folder where its first view is, and lists its views nowhere else", () => {
        const f = folder("f", ["d", "b"]);
        expect(sidebarItems(visible, [f])).toEqual([
            { kind: "view", tabId: "a" },
            { kind: "folder", folder: f, members: ["d", "b"] },
            { kind: "view", tabId: "c" },
            { kind: "view", tabId: "e" },
        ]);
    });

    it("shows a folder with one visible view as that view's own row", () => {
        const f = folder("f", ["b", "hidden"]);
        expect(sidebarItems(visible, [f]).every((item) => item.kind === "view")).toBe(true);
        expect(shownFolders(visible, [f])).toEqual([]);
    });

    it("counts only the views the list shows", () => {
        const f = folder("f", ["a", "gone", "c"]);
        const items = sidebarItems(visible, [f]);
        expect(items[0]).toEqual({ kind: "folder", folder: f, members: ["a", "c"] });
    });

    it("Clear closes only the views outside folders", () => {
        const folders = [folder("f", ["b", "c"]), folder("g", ["e", "hidden"])];
        expect(closableViews(visible, folders)).toEqual(["a", "d", "e"]);
        expect([...folderedViews(visible, folders)].sort()).toEqual(["b", "c"]);
        expect(closableViews(visible, [])).toEqual(visible);
    });
});

describe("making a folder", () => {
    it("makes a folder of the two views, the target first", () => {
        expect(dropOnView([], "a", "b", "f1")).toEqual([folder("f1", ["b", "a"])]);
    });

    it("adds the view at the end of the target's folder", () => {
        const folders = [folder("f", ["b", "c"])];
        expect(dropOnView(folders, "a", "c", "new")).toEqual([folder("f", ["b", "c", "a"])]);
    });

    it("moves a view from a folder to the target's folder, dissolving the one it leaves", () => {
        const folders = [folder("f", ["a", "b"]), folder("g", ["c", "d"])];
        expect(dropOnView(folders, "a", "c", "new")).toEqual([folder("g", ["c", "d", "a"])]);
    });

    it("makes a new folder of a view taken from a bigger one", () => {
        const folders = [folder("f", ["a", "b", "x"])];
        expect(dropOnView(folders, "a", "c", "new")).toEqual([folder("f", ["b", "x"]), folder("new", ["c", "a"])]);
    });

    it("does nothing for a drop on itself", () => {
        const folders = [folder("f", ["a", "b"])];
        expect(dropOnView(folders, "a", "a", "new")).toEqual(folders);
    });

    it("adds a view at a place of a folder, and ignores a folder that is not there", () => {
        const folders = [folder("f", ["a", "b"])];
        expect(addToFolder(folders, "f", "c", 1)).toEqual([folder("f", ["a", "c", "b"])]);
        expect(addToFolder(folders, "f", "c", 99)).toEqual([folder("f", ["a", "b", "c"])]);
        expect(addToFolder(folders, "nope", "c")).toEqual(folders);
    });
});

describe("taking out, dissolving, renaming, reordering", () => {
    it("takes a view out and keeps the folder while it holds two", () => {
        expect(takeOut([folder("f", ["a", "b", "c"])], "b")).toEqual([folder("f", ["a", "c"])]);
    });

    it("dissolves a folder left with one view", () => {
        expect(takeOut([folder("f", ["a", "b"])], "a")).toEqual([]);
        expect(dissolveSmall([folder("f", ["a"]), folder("g", ["b", "c"])])).toEqual([folder("g", ["b", "c"])]);
    });

    it("dissolves a folder on request", () => {
        expect(dissolveFolder([folder("f", ["a", "b"]), folder("g", ["c", "d"])], "f")).toEqual([
            folder("g", ["c", "d"]),
        ]);
    });

    it("renames, and an empty name gives the name back to the content", () => {
        const folders = [folder("f", ["a", "b"])];
        expect(renameFolder(folders, "f", "  Reviews  ")[0].name).toBe("Reviews");
        expect(renameFolder(renameFolder(folders, "f", "Reviews"), "f", "   ")[0].name).toBe("");
    });

    it("moves a view one place inside its folder, never out of it", () => {
        const folders = [folder("f", ["a", "b", "c"])];
        expect(moveInFolder(folders, "f", "b", 1)[0].tabids).toEqual(["a", "c", "b"]);
        expect(moveInFolder(folders, "f", "b", -1)[0].tabids).toEqual(["b", "a", "c"]);
        expect(moveInFolder(folders, "f", "a", -1)[0].tabids).toEqual(["a", "b", "c"]);
        expect(moveInFolder(folders, "f", "c", 1)[0].tabids).toEqual(["a", "b", "c"]);
        expect(moveInFolder(folders, "f", "zz", 1)).toEqual(folders);
    });

    it("prunes the views that are gone and dissolves what is left small", () => {
        const folders = [folder("f", ["a", "b", "c"]), folder("g", ["d", "e"])];
        expect(pruneViewFolders(folders, new Set(["a", "c", "d"]))).toEqual([folder("f", ["a", "c"])]);
        expect(pruneViewFolders(folders, new Set(["a", "b", "c", "d", "e"]))).toEqual(folders);
    });

    it("finds the folder of a view", () => {
        const folders = [folder("f", ["a", "b"])];
        expect(folderOf(folders, "b")?.id).toBe("f");
        expect(folderOf(folders, "z")).toBeNull();
    });
});

describe("the workspace's tab order", () => {
    const order = ["a", "b", "c", "d", "e"];

    it("moves a folder's views side by side before a tab, keeping their order", () => {
        expect(moveRunBefore(order, ["e", "b"], "d")).toEqual(["a", "c", "b", "e", "d"]);
        expect(moveRunBefore(order, ["b", "c"], "a")).toEqual(["b", "c", "a", "d", "e"]);
    });

    it("moves them to the end for no target, and nowhere for a target among them", () => {
        expect(moveRunBefore(order, ["a", "b"], null)).toEqual(["c", "d", "e", "a", "b"]);
        expect(moveRunBefore(order, ["a", "b"], "b")).toEqual(order);
    });

    it("lands a view right after the last of some tabs", () => {
        expect(moveAfterLast(order, "a", ["c", "d"])).toEqual(["b", "c", "d", "a", "e"]);
        expect(moveAfterLast(order, "e", ["a", "e"])).toEqual(["a", "e", "b", "c", "d"]);
        expect(moveAfterLast(order, "a", ["zz"])).toEqual(order);
    });

    it("anchors a folder at its first view in the list", () => {
        expect(folderAnchor(["x", "c", "b"], ["b", "c"])).toBe("c");
        expect(folderAnchor(["x"], ["b", "c"])).toBeNull();
    });
});

describe("the name a folder shows from its content", () => {
    const k = (view: string, url = "", agent = false, host = "") => viewKindOf(view, url, agent, host);

    it("reads a view's kind from its first panel", () => {
        expect(k("molten-review").kind).toBe("review");
        expect(k("molten-reviews").kind).toBe("review");
        expect(k("term").kind).toBe("terminal");
        expect(k("term", "", true).kind).toBe("agent");
        expect(k("preview").kind).toBe("files");
        expect(k("molten-browser", "https://example.com/", false, "example.com").kind).toBe("web");
        expect(k("molten-browser", "https://github.com/o/r/pull/12").kind).toBe("review");
        expect(k("web", "https://github.com/o/r/pulls").kind).toBe("review");
        expect(k("sysinfo").kind).toBe("other");
    });

    it("tells a pull request page from another", () => {
        expect(isPullRequestUrl("https://github.com/o/r/pull/2475")).toBe(true);
        expect(isPullRequestUrl("https://github.com/o/r/issues/1")).toBe(false);
        expect(isPullRequestUrl("not a url")).toBe(false);
    });

    it("names a folder after what all its views are", () => {
        const pr = k("molten-browser", "https://github.com/o/r/pull/1");
        expect(derivedFolderName([pr, pr, k("molten-review")])).toEqual({ key: "review" });
        expect(derivedFolderName([k("term"), k("term")])).toEqual({ key: "terminals" });
        expect(derivedFolderName([k("preview"), k("preview")])).toEqual({ key: "files" });
        expect(derivedFolderName([k("term", "", true), k("term", "", true)])).toEqual({ key: "agents" });
    });

    it("names a folder of pages after their site when they share one", () => {
        const a = k("molten-browser", "https://docs.x.com/a", false, "x.com");
        const b = k("molten-browser", "https://x.com/b", false, "x.com");
        const c = k("molten-browser", "https://y.org/", false, "y.org");
        expect(derivedFolderName([a, b])).toEqual({ key: "site", site: "x.com" });
        expect(derivedFolderName([a, c])).toEqual({ key: "pages" });
        expect(derivedFolderName([k("molten-browser"), k("molten-browser")])).toEqual({ key: "pages" });
    });

    it("falls back to Folder for a mix, an unknown kind or nothing", () => {
        expect(derivedFolderName([k("term"), k("preview")])).toEqual({ key: "mixed" });
        expect(derivedFolderName([k("sysinfo"), k("sysinfo")])).toEqual({ key: "mixed" });
        expect(derivedFolderName([])).toEqual({ key: "mixed" });
    });
});

describe("the name and the news a folder shows", () => {
    const t = (key: string) => `[${key}]`;
    const review = { kind: "review" as const };

    it("shows the developer's name, else the content's", () => {
        expect(folderShownName(folder("f", ["a", "b"], "Mine"), [review, review], t)).toBe("Mine");
        expect(folderShownName(folder("f", ["a", "b"]), [review, review], t)).toBe("[sidebar.folders.name.review]");
        expect(
            folderShownName(
                folder("f", ["a", "b"]),
                [
                    { kind: "web", host: "x.com" },
                    { kind: "web", host: "x.com" },
                ],
                t
            )
        ).toBe("x.com");
        expect(folderShownName(folder("f", ["a", "b"]), [], t)).toBe("[sidebar.folders.name.mixed]");
    });

    it("has news for a badge, or an agent that waits, ended or failed", () => {
        expect(viewHasNews(0, [])).toBe(false);
        expect(viewHasNews(1, [])).toBe(true);
        expect(viewHasNews(0, ["working", "idle"])).toBe(false);
        expect(viewHasNews(0, ["working", "waiting"])).toBe(true);
        expect(viewHasNews(0, ["done"])).toBe(true);
        expect(viewHasNews(0, ["error"])).toBe(true);
    });
});

describe("choosing between reordering and making a folder", () => {
    const slots = [
        { key: "tab:a", top: 0, height: 32 },
        { key: "tab:b", top: 33, height: 32 },
        { key: "folder:f", top: 66, height: 32 },
    ];

    it("rings the row whose middle the pointer is on, not its edges", () => {
        expect(folderCandidateAt(49, slots, "tab:a")).toBe("tab:b");
        expect(folderCandidateAt(34, slots, "tab:a")).toBeNull();
        expect(folderCandidateAt(64, slots, "tab:a")).toBeNull();
        expect(folderCandidateAt(82, slots, "tab:a")).toBe("folder:f");
    });

    it("never rings the dragged row", () => {
        expect(folderCandidateAt(16, slots, "tab:a")).toBeNull();
    });

    it("starts a dwell over a row, keeps it while the pointer stays and restarts on another row", () => {
        const first = nextDwell(null, "tab:b", 1000);
        expect(first).toEqual({ key: "tab:b", since: 1000 });
        expect(nextDwell(first, "tab:b", 1200)).toBe(first);
        expect(nextDwell(first, "folder:f", 1300)).toEqual({ key: "folder:f", since: 1300 });
        expect(nextDwell(first, null, 1300)).toBeNull();
    });

    it("is done once it lasted the delay", () => {
        const d = { key: "tab:b", since: 1000 };
        expect(dwellDone(d, 1000 + FolderDwellMs - 1)).toBe(false);
        expect(dwellDone(d, 1000 + FolderDwellMs)).toBe(true);
        expect(dwellDone(null, 5000)).toBe(false);
    });
});
