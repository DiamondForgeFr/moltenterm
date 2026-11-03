// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The menu of the web page panel's Bookmarks button (FR-BRW-019), shown by the MenuHost like every MoltenTerm menu: the
// current project's bookmarks (those directly in the project, then each folder as a submenu), then Bookmark this page…
// and Manage bookmarks…. Choosing a bookmark opens it in the shown tab; the menu itself opens nothing. Unavailable
// actions are absent, not disabled (FR-SHELL-049).

import { t } from "../i18n/i18n";
import { Bookmark, bookmarksOfFolder, findBookmarkByAddress, ProjectBookmarks } from "./bookmarks";
import { shownAddress } from "./browser-model";

export type BookmarksMenuInput = {
    // null: the workspace has no project, so there is nothing to keep bookmarks in.
    projectName: string;
    // Only a workspace with several projects names the project in the menu.
    multi: boolean;
    data: ProjectBookmarks;
    // The shown page's address when it can be bookmarked (not the start page), else "".
    pageUrl: string;
};

export type BookmarksMenuActions = {
    open: (url: string) => void;
    bookmarkPage: () => void;
    editBookmark: (bookmark: Bookmark) => void;
    manage: () => void;
};

function bookmarkItem(b: Bookmark, open: (url: string) => void): ContextMenuItem {
    return {
        label: b.title,
        sublabel: shownAddress(b.url),
        icon: "bookmark",
        tooltip: b.description || b.url,
        click: () => open(b.url),
    };
}

export function bookmarksMenu(input: BookmarksMenuInput, actions: BookmarksMenuActions): ContextMenuItem[] {
    if (input.projectName == null) {
        return [{ type: "header", label: t("browser.bookmarks.menu.noProject") }];
    }
    const { data } = input;
    const menu: ContextMenuItem[] = [];
    if (input.multi) {
        menu.push({ type: "header", label: t("browser.bookmarks.menu.project", { project: input.projectName }) });
    }
    if (data.items.length === 0) {
        menu.push({ type: "header", label: t("browser.bookmarks.menu.empty") });
    }
    for (const b of bookmarksOfFolder(data, "")) {
        menu.push(bookmarkItem(b, actions.open));
    }
    for (const folder of data.folders) {
        const inside = bookmarksOfFolder(data, folder.id);
        if (inside.length === 0) {
            continue;
        }
        menu.push({
            label: folder.name,
            type: "submenu",
            icon: "folder",
            submenu: inside.map((b) => bookmarkItem(b, actions.open)),
        });
    }
    menu.push({ type: "separator" });
    if (input.pageUrl !== "") {
        const existing = findBookmarkByAddress(data, input.pageUrl);
        menu.push(
            existing != null
                ? {
                      label: t("browser.bookmarks.menu.editBookmark"),
                      icon: "pen",
                      click: () => actions.editBookmark(existing),
                  }
                : { label: t("browser.bookmarks.menu.bookmarkPage"), icon: "plus", click: () => actions.bookmarkPage() }
        );
    }
    menu.push({ label: t("browser.bookmarks.menu.manage"), icon: "sliders", click: () => actions.manage() });
    return menu;
}
