// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the developer does to the folders of views (FR-SHELL-080, #2484): make one, fill it, take a view out, rename it,
// dissolve it, reorder it. Each asks the workspace's tab order for the views to stand side by side and writes the
// folders (view-folders-store.ts). Loaded on demand, the first time one is done, so that the startup bundle holds only
// what the Views list draws (NFR-PERF-003); the rules are in view-folders-edit.ts.

import { v4 as uuidv4 } from "uuid";
import { t } from "../i18n/i18n";
import {
    addToFolder,
    dissolveFolder,
    dropOnView,
    moveAfterLast,
    moveInFolder,
    moveRunBefore,
    renameFolder,
    takeOut,
} from "./view-folders-edit";
import { folderOf, sameViewFolders } from "./view-folders-model";
import {
    announceFolders,
    currentFolders,
    listTabs,
    tabOrder,
    viewName,
    writeFolders,
    writeTabOrder,
} from "./view-folders-store";
import { moveBeside } from "./view-menu-model";

// A view dropped on another view (they make a folder) or on a folder's row (the view joins it).
export async function dropViewOnView(dragged: string, target: string): Promise<void> {
    const folders = currentFolders();
    if (dragged === target) {
        return;
    }
    const id = uuidv4();
    const next = dropOnView(folders, dragged, target, id);
    const targetFolder = folderOf(folders, target);
    const order = tabOrder();
    // The views stand side by side, the dragged one after the target (or after the folder's last view).
    await writeTabOrder(
        targetFolder == null
            ? moveBeside(order, dragged, target, true)
            : moveAfterLast(order, dragged, targetFolder.tabids)
    );
    await writeFolders(next);
    const made = next.find((f) => f.id === id);
    announceFolders(
        targetFolder == null
            ? t("sidebar.folders.announce.created", { count: made?.tabids.length ?? 2 })
            : t("sidebar.folders.announce.added", { name: viewName(dragged) })
    );
}

// A view dropped on a folder (the folder's own row), not on one of its views.
export async function addViewToFolder(folderId: string, tabId: string): Promise<void> {
    const folders = currentFolders();
    const folder = folders.find((f) => f.id === folderId);
    if (folder == null || folder.tabids.includes(tabId)) {
        return;
    }
    await writeTabOrder(moveAfterLast(tabOrder(), tabId, folder.tabids));
    await writeFolders(addToFolder(folders, folderId, tabId));
    announceFolders(t("sidebar.folders.announce.added", { name: viewName(tabId) }));
}

// Where a view taken out of its folder lands: before a row of the list, after the list's last row, or just after the
// folder it leaves.
export type TakeOutPlace = { before: string } | { end: true } | { afterFolder: true };

export async function takeViewOut(tabId: string, place: TakeOutPlace = { afterFolder: true }): Promise<void> {
    const folders = currentFolders();
    const folder = folderOf(folders, tabId);
    if (folder == null) {
        return;
    }
    const order = tabOrder();
    let next = order;
    if ("before" in place) {
        next = moveBeside(order, tabId, place.before, false);
    } else if ("end" in place) {
        next = moveAfterLast(order, tabId, listTabs());
    } else {
        next = moveAfterLast(order, tabId, folder.tabids);
    }
    await writeTabOrder(next);
    await writeFolders(takeOut(folders, tabId));
    announceFolders(t("sidebar.folders.announce.takenOut", { name: viewName(tabId) }));
}

export async function renameViewFolder(folderId: string, name: string): Promise<void> {
    const folders = currentFolders();
    const next = renameFolder(folders, folderId, name);
    if (sameViewFolders(next, folders)) {
        return;
    }
    await writeFolders(next);
}

export async function dissolveViewFolder(folderId: string): Promise<void> {
    const folders = currentFolders();
    if (!folders.some((f) => f.id === folderId)) {
        return;
    }
    await writeFolders(dissolveFolder(folders, folderId));
    announceFolders(t("sidebar.folders.announce.dissolved"));
}

export async function moveViewInFolder(folderId: string, tabId: string, delta: number): Promise<void> {
    const folders = currentFolders();
    const next = moveInFolder(folders, folderId, tabId, delta);
    if (sameViewFolders(next, folders)) {
        return;
    }
    await writeFolders(next);
    const position = next.find((f) => f.id === folderId)?.tabids.indexOf(tabId) ?? 0;
    announceFolders(
        t("sidebar.folders.announce.moved", {
            name: viewName(tabId),
            position: position + 1,
            total: next.find((f) => f.id === folderId)?.tabids.length ?? 0,
        })
    );
}

// The tab after the Views list's last one in the workspace's order: what a drop at the list's end lands before.
function followingTab(order: string[]): string {
    const list = listTabs();
    const last = list[list.length - 1];
    const at = order.indexOf(last);
    return at >= 0 && at + 1 < order.length ? order[at + 1] : null;
}

// A folder dragged in the list: its views leave their places and stand side by side before a row, or at the end.
export async function moveFolderBefore(folderId: string, before: string): Promise<void> {
    const folder = currentFolders().find((f) => f.id === folderId);
    if (folder == null) {
        return;
    }
    const order = tabOrder();
    await writeTabOrder(
        before == null
            ? moveRunBefore(order, folder.tabids, followingTab(order))
            : moveRunBefore(order, folder.tabids, before)
    );
}
