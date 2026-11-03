// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { layoutMenuItems } from "../menu/menu-model";
import { ProjectBookmarks } from "./bookmarks";
import { BookmarksMenuActions, bookmarksMenu } from "./bookmarks-menu";

const data: ProjectBookmarks = {
    folders: [
        { id: "f1", name: "Docs" },
        { id: "f2", name: "Empty folder" },
        { id: "f3", name: "Ops" },
    ],
    items: [
        {
            id: "b1",
            url: "https://vite.dev/config/",
            title: "Vite config",
            description: "The build options.",
            folder: "f1",
        },
        { id: "b2", url: "https://staging.example.com/", title: "Staging", description: "", folder: "" },
        {
            id: "b3",
            url: "https://grafana.example.com/d/abc",
            title: "Dashboards",
            description: "Latency.",
            folder: "f3",
        },
    ],
};

const none: ProjectBookmarks = { folders: [], items: [] };

function actions(): BookmarksMenuActions {
    return { open: vi.fn(), bookmarkPage: vi.fn(), editBookmark: vi.fn(), manage: vi.fn() };
}

const labels = (menu: ContextMenuItem[]) => menu.map((i) => i.label ?? i.type);

describe("the Bookmarks menu", () => {
    it("lists the project's bookmarks first, then its folders as submenus, then the actions", () => {
        const menu = bookmarksMenu(
            { projectName: "Desktop", multi: false, data, pageUrl: "https://example.com/new" },
            actions()
        );
        expect(labels(menu)).toEqual([
            "Staging",
            "Docs",
            "Ops",
            "separator",
            "Bookmark this page…",
            "Manage bookmarks…",
        ]);
        const docs = menu.find((i) => i.label === "Docs");
        expect(docs.type).toBe("submenu");
        expect(docs.submenu.map((i) => i.label)).toEqual(["Vite config"]);
    });

    it("opens a bookmark on its click and nothing before", () => {
        const a = actions();
        const menu = bookmarksMenu({ projectName: "Desktop", multi: false, data, pageUrl: "" }, a);
        expect(a.open).not.toHaveBeenCalled();
        menu.find((i) => i.label === "Staging").click();
        expect(a.open).toHaveBeenCalledWith("https://staging.example.com/");
        menu.find((i) => i.label === "Docs").submenu[0].click();
        expect(a.open).toHaveBeenLastCalledWith("https://vite.dev/config/");
        expect(a.bookmarkPage).not.toHaveBeenCalled();
    });

    it("shows the address under a bookmark and its description on hover", () => {
        const menu = bookmarksMenu({ projectName: "Desktop", multi: false, data, pageUrl: "" }, actions());
        const vite = menu.find((i) => i.label === "Docs").submenu[0];
        expect(vite.sublabel).toBe("vite.dev/config/");
        expect(vite.tooltip).toBe("The build options.");
        expect(menu.find((i) => i.label === "Staging").tooltip).toBe("https://staging.example.com/");
    });

    it("offers to edit the bookmark of a page the project already holds instead of adding it twice", () => {
        const a = actions();
        const menu = bookmarksMenu(
            { projectName: "Desktop", multi: false, data, pageUrl: "https://vite.dev/config" },
            a
        );
        expect(labels(menu)).toContain("Edit this bookmark…");
        expect(labels(menu)).not.toContain("Bookmark this page…");
        menu.find((i) => i.label === "Edit this bookmark…").click();
        expect(a.editBookmark).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" }));
    });

    it("has no add entry on the start page, and still a way to manage", () => {
        const menu = bookmarksMenu({ projectName: "Desktop", multi: false, data, pageUrl: "" }, actions());
        expect(labels(menu)).not.toContain("Bookmark this page…");
        expect(labels(menu)).toContain("Manage bookmarks…");
    });

    it("heads the bookmarks with the project's name when the workspace has several projects", () => {
        const menu = bookmarksMenu(
            { projectName: "Website", multi: true, data, pageUrl: "https://example.com/" },
            actions()
        );
        const shown = layoutMenuItems(menu);
        expect(shown[0]).toMatchObject({ type: "header", label: "Bookmarks of Website" });
        expect(shown.find((i) => i.label === "Staging")).toBeDefined();
    });

    it("says there is no bookmark under the row that adds one, never as an inert row", () => {
        const menu = bookmarksMenu(
            { projectName: "Website", multi: true, data: none, pageUrl: "https://example.com/" },
            actions()
        );
        expect(menu.some((i) => i.type === "header")).toBe(false);
        const shown = layoutMenuItems(menu);
        expect(shown.map((i) => i.label)).toEqual(["Bookmark this page…", "Manage bookmarks…"]);
        expect(shown[0].sublabel).toBe("No bookmark in this project yet");
        const startPage = layoutMenuItems(
            bookmarksMenu({ projectName: "Website", multi: false, data: none, pageUrl: "" }, actions())
        );
        expect(startPage.map((i) => i.label)).toEqual(["Manage bookmarks…"]);
        expect(startPage[0].sublabel).toBe("No bookmark in this project yet");
    });

    it("explains that bookmarks belong to a project in a workspace without one, on a row that does something", () => {
        const a = actions();
        const menu = bookmarksMenu({ projectName: null, multi: false, data, pageUrl: "https://example.com/" }, a);
        expect(menu).toHaveLength(1);
        expect(menu[0].label).toBe("Manage bookmarks…");
        expect(menu[0].sublabel).toContain("belong to a project");
        menu[0].click();
        expect(a.manage).toHaveBeenCalled();
    });
});
