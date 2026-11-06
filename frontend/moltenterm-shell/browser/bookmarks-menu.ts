// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The menu of the web page panel's Bookmarks button (FR-BRW-019), shown by the MenuHost like every MoltenTerm menu: the
// current project's bookmarks (those directly in the project, then each folder as a submenu), then Bookmark this page…
// and Manage bookmarks…. Choosing a bookmark opens it in the shown tab; the menu itself opens nothing. Unavailable
// actions are absent, not disabled (FR-SHELL-049).

import type { SiteIcon } from "../favicon/favicon-store";
import { GenericWebIcon, originOfAddress } from "../favicon/site";
import { t } from "../i18n/i18n";
import { Bookmark, bookmarksOfFolder, findBookmarkByAddress, ProjectBookmarks } from "./bookmarks";
import { shownAddress } from "./browser-model";

export type BookmarksMenuInput = {
    // The sites' icons known to the window (#1962): a bookmark wears its site's icon, the generic web icon when its site's
    // was never kept (a page not visited yet).
    icons?: Record<string, SiteIcon>;
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

function bookmarkItem(b: Bookmark, open: (url: string) => void, icons?: Record<string, SiteIcon>): ContextMenuItem {
    const icon = icons?.[originOfAddress(b.url)];
    return {
        label: b.title,
        sublabel: shownAddress(b.url),
        icon: GenericWebIcon,
        iconImage: icon?.url,
        tooltip: b.description || b.url,
        click: () => open(b.url),
    };
}

export function bookmarksMenu(input: BookmarksMenuInput, actions: BookmarksMenuActions): ContextMenuItem[] {
    const manage: ContextMenuItem = {
        label: t("browser.bookmarks.menu.manage"),
        icon: "sliders",
        click: () => actions.manage(),
    };
    // A menu has no inert rows (FR-SHELL-054): what is missing is said under the row that can fix it.
    if (input.projectName == null) {
        return [{ ...manage, sublabel: t("browser.bookmarks.menu.noProject") }];
    }
    const { data } = input;
    const empty = data.items.length === 0 ? t("browser.bookmarks.menu.empty") : undefined;
    const menu: ContextMenuItem[] = [];
    // A heading only shows when the menu has two sections: the project's bookmarks, then the actions.
    if (input.multi && !empty) {
        menu.push({ type: "header", label: t("browser.bookmarks.menu.project", { project: input.projectName }) });
    }
    for (const b of bookmarksOfFolder(data, "")) {
        menu.push(bookmarkItem(b, actions.open, input.icons));
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
            submenu: inside.map((b) => bookmarkItem(b, actions.open, input.icons)),
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
                : {
                      label: t("browser.bookmarks.menu.bookmarkPage"),
                      icon: "plus",
                      sublabel: empty,
                      click: () => actions.bookmarkPage(),
                  }
        );
        menu.push(manage);
        return menu;
    }
    menu.push({ ...manage, sublabel: empty });
    return menu;
}
