// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The right-click menus of the bookmarks panel (FR-BRW-019, #2531, mockup section 3), shown by the MenuHost like every
// MoltenTerm menu. In a column: New folder here, Add the page here, Paste. On a bookmark: Edit, Places…, Cut, Copy, Remove.
// A menu has no inert rows (FR-SHELL-054): a Paste with nothing to paste says why under it, and Add the page is absent when
// the shown page cannot be bookmarked. Contexts, workspaces and projects are never created from here: no menu offers it.

import type { TFunction } from "../i18n/i18n";
import { placeTitle } from "./bookmark-parts";
import { nodeOf, PlaceCatalog } from "./bookmark-places";
import { selectionOfPlace, type PanelSelection } from "./bookmarks-columns";
import { Bookmark, BookmarkStore, folderNameAt, PlaceRef } from "./bookmarks";

export type ColumnMenuInput = { canAddPage: boolean; canPaste: boolean };

export type ColumnMenuActions = {
    newFolder: () => void;
    addPage: () => void;
    paste: () => void;
};

function pasteItem(t: TFunction, input: ColumnMenuInput, actions: ColumnMenuActions): ContextMenuItem {
    return {
        label: t("browser.bookmarks.menu.paste"),
        icon: "paste",
        sublabel: input.canPaste ? undefined : t("browser.bookmarks.menu.pasteEmpty"),
        click: input.canPaste ? actions.paste : () => {},
    };
}

function addPageItem(t: TFunction, input: ColumnMenuInput, actions: ColumnMenuActions): ContextMenuItem[] {
    return input.canAddPage
        ? [{ label: t("browser.bookmarks.menu.addPageHere"), icon: "bookmark", click: actions.addPage }]
        : [];
}

export function columnMenu(t: TFunction, input: ColumnMenuInput, actions: ColumnMenuActions): ContextMenuItem[] {
    return [
        { label: t("browser.bookmarks.menu.newFolderHere"), icon: "folder-plus", click: actions.newFolder },
        ...addPageItem(t, input, actions),
        { type: "separator" },
        pasteItem(t, input, actions),
    ];
}

export type FolderMenuActions = Omit<ColumnMenuActions, "newFolder"> & { rename: () => void; remove: () => void };

// A folder holds no folder: its menu adds the page into it, pastes into it, renames it or deletes it (its bookmarks stay).
export function folderMenu(t: TFunction, input: ColumnMenuInput, actions: FolderMenuActions): ContextMenuItem[] {
    const own = { ...actions, newFolder: () => {} };
    return [
        ...addPageItem(t, input, own),
        pasteItem(t, input, own),
        { type: "separator" },
        { label: t("browser.bookmarks.menu.renameFolder"), icon: "pen", click: actions.rename },
        {
            label: t("browser.bookmarks.menu.deleteFolder"),
            icon: "trash",
            destructive: true,
            sublabel: t("browser.bookmarks.menu.deleteFolderHint"),
            click: actions.remove,
        },
    ];
}

// The places of a bookmark as a submenu: choosing one walks the panel there; the last row opens the popover that edits them.
export function placesMenu(
    t: TFunction,
    b: Bookmark,
    catalog: PlaceCatalog,
    store: BookmarkStore,
    go: (selection: PanelSelection) => void,
    edit: () => void
): ContextMenuItem[] {
    const items: ContextMenuItem[] = b.places.map((p) => ({
        label: placeTitle(t, p, nodeOf(catalog, p)?.name ?? ""),
        sublabel: folderNameAt(store, p, p.folder) || undefined,
        icon: "location-dot",
        click: () => go(selectionOfPlace(catalog, p, p.folder)),
    }));
    return [...items, { type: "separator" }, { label: t("browser.bookmarks.menu.editPlaces"), icon: "pen", click: edit }];
}

export type RowMenuActions = {
    edit: () => void;
    go: (selection: PanelSelection) => void;
    cut: () => void;
    copy: () => void;
    remove: () => void;
    removeEverywhere: () => void;
};

// The menu of a bookmark listed in a column of a place; in the results of a search there is no place to remove it from.
export function bookmarkMenu(
    t: TFunction,
    b: Bookmark,
    context: { catalog: PlaceCatalog; store: BookmarkStore; from: PlaceRef | null },
    actions: RowMenuActions
): ContextMenuItem[] {
    const menu: ContextMenuItem[] = [
        { label: t("browser.bookmarks.menu.edit"), icon: "pen", click: actions.edit },
        {
            label: t("browser.bookmarks.menu.places"),
            icon: "location-dot",
            type: "submenu",
            submenu: placesMenu(t, b, context.catalog, context.store, actions.go, actions.edit),
        },
    ];
    if (context.from != null) {
        menu.push(
            { type: "separator" },
            { label: t("browser.bookmarks.menu.cut"), icon: "scissors", click: actions.cut },
            { label: t("browser.bookmarks.menu.copy"), icon: "copy", click: actions.copy },
            { type: "separator" },
            { label: t("browser.bookmarks.menu.remove"), icon: "trash", destructive: true, click: actions.remove }
        );
    }
    if (context.from == null || b.places.length > 1) {
        if (context.from == null) {
            menu.push({ type: "separator" });
        }
        menu.push({
            label: t("browser.bookmarks.menu.removeEverywhere"),
            icon: "trash",
            destructive: true,
            click: actions.removeEverywhere,
        });
    }
    return menu;
}
