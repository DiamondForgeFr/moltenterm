// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Bookmarks wear their site's icon wherever they are listed (#1962, FR-BRW-019 AC11): the menu draws the icon kept for the
// bookmark's origin, the generic web icon when its site was never visited.

import { describe, expect, it, vi } from "vitest";
import { ProjectBookmarks } from "./bookmarks";
import { BookmarksMenuActions, bookmarksMenu } from "./bookmarks-menu";

const data: ProjectBookmarks = {
    folders: [{ id: "f1", name: "Docs" }],
    items: [
        { id: "b1", url: "https://vite.dev/config/", title: "Vite config", description: "", folder: "f1" },
        { id: "b2", url: "https://staging.example.com/a", title: "Staging", description: "", folder: "" },
        { id: "b3", url: "https://never-visited.test/", title: "Never visited", description: "", folder: "" },
    ],
};

const actions = (): BookmarksMenuActions => ({
    open: vi.fn(),
    bookmarkPage: vi.fn(),
    editBookmark: vi.fn(),
    manage: vi.fn(),
});

const input = (icons?: Record<string, { url: string }>) => ({
    projectName: "Shop",
    multi: false,
    data,
    pageUrl: "",
    icons,
});

const bookmark = (menu: ContextMenuItem[], title: string): ContextMenuItem =>
    menu.flatMap((i) => (i.type === "submenu" ? i.submenu : [i])).find((i) => i.label === title);

describe("a bookmark's icon in the Bookmarks menu (#1962)", () => {
    const icons = {
        "https://staging.example.com": { url: "data:image/png;base64,U1RBR0lORw==" },
        "https://vite.dev": { url: "data:image/png;base64,VklURQ==" },
    };

    it("is the icon kept for its site, in the menu and in its folder's submenu", () => {
        const menu = bookmarksMenu(input(icons), actions());
        expect(bookmark(menu, "Staging").iconImage).toBe(icons["https://staging.example.com"].url);
        expect(bookmark(menu, "Vite config").iconImage).toBe(icons["https://vite.dev"].url);
    });

    it("is the generic web icon for a site that was never visited, never an image", () => {
        const menu = bookmarksMenu(input(icons), actions());
        const never = bookmark(menu, "Never visited");
        expect(never.iconImage).toBeUndefined();
        expect(never.icon).toBe("globe");
    });

    it("is the generic web icon everywhere when no icon is known at all", () => {
        const menu = bookmarksMenu(input(undefined), actions());
        for (const title of ["Vite config", "Staging", "Never visited"]) {
            expect(bookmark(menu, title).iconImage).toBeUndefined();
            expect(bookmark(menu, title).icon).toBe("globe");
        }
    });

    it("still opens the page on a click, and changes nothing else of the menu", () => {
        const a = actions();
        const menu = bookmarksMenu(input(icons), a);
        bookmark(menu, "Staging").click();
        expect(a.open).toHaveBeenCalledWith("https://staging.example.com/a");
        expect(menu.some((i) => i.type === "submenu" && i.label === "Docs")).toBe(true);
    });
});
