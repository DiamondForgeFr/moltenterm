// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The folders of views of the window's workspace (FR-SHELL-080, #2484): read from the workspace's meta, changed by the
// operations below, which also order the workspace's tabs so that a folder's views stand side by side. A write is read
// back from wavesrv before its pending value goes (as the sidebar's own meta writes are), so that two changes in a row
// never start from a stale list. The rules are in view-folders-model.ts.

import { atoms, globalStore, WOS } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import * as jotai from "jotai";
import { v4 as uuidv4 } from "uuid";
import { t } from "../i18n/i18n";
import { viewDisplayName } from "../tab-identity-ui";
import { SidebarModel } from "./sidebar-store";
import {
    addToFolder,
    closableViews,
    dissolveFolder,
    dropOnView,
    folderAnchor,
    folderOf,
    moveAfterLast,
    moveInFolder,
    moveRunBefore,
    pruneViewFolders,
    readViewFolders,
    renameFolder,
    sameViewFolders,
    shownFolders,
    takeOut,
    ViewFolder,
    ViewFoldersMetaKey,
} from "./view-folders-model";
import type { ViewMenuFolderHooks } from "./view-menu";
import { moveBeside, sameOrder } from "./view-menu-model";

// The folder written and not yet read back, with the workspace it belongs to.
type Pending = { workspaceId: string; folders: ViewFolder[] };

export const pendingFoldersAtom = jotai.atom(null) as jotai.PrimitiveAtom<Pending>;

// The folder shown open over the sidebar, by id; null when none is.
export const openFolderAtom = jotai.atom(null) as jotai.PrimitiveAtom<string>;

// The folder opens with its name field ready: the row's menu asked to rename it.
export const folderRenameAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;

// The sentence the live region says after a change; a zero-width mark makes the same sentence new again.
export const folderNoteAtom = jotai.atom("") as jotai.PrimitiveAtom<string>;
const InvisibleMark = String.fromCharCode(0x200b);
let marked = false;

export function announceFolders(text: string) {
    marked = !marked;
    globalStore.set(folderNoteAtom, marked ? `${text}${InvisibleMark}` : text);
}

// The folders of the window's workspace: the ones just written while wavesrv has not echoed them, else the meta's.
export const viewFoldersAtom = jotai.atom((get) => {
    const ws = get(atoms.workspace);
    const pending = get(pendingFoldersAtom);
    if (pending != null && pending.workspaceId === ws?.oid) {
        return pending.folders;
    }
    return readViewFolders(ws?.meta);
}) as jotai.Atom<ViewFolder[]>;

function currentFolders(): ViewFolder[] {
    return globalStore.get(viewFoldersAtom);
}

export function openFolder(folderId: string) {
    globalStore.set(openFolderAtom, folderId);
}

export function closeFolder() {
    globalStore.set(openFolderAtom, null);
}

let writing: Promise<void> = Promise.resolve();

// Serial, so that a change made while another is written starts from the first one's result.
function writeFolders(next: ViewFolder[]): Promise<void> {
    const ws = globalStore.get(atoms.workspace);
    if (ws == null) {
        return Promise.resolve();
    }
    globalStore.set(pendingFoldersAtom, { workspaceId: ws.oid, folders: next });
    const oref = WOS.makeORef("workspace", ws.oid);
    const run = async () => {
        try {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref,
                meta: { [ViewFoldersMetaKey]: next.length > 0 ? next : null } as MetaType,
            });
            await WOS.reloadWaveObject<Workspace>(oref);
        } catch (e) {
            console.log("saving the folders of views", e);
        } finally {
            const pending = globalStore.get(pendingFoldersAtom);
            if (pending != null && pending.folders === next) {
                globalStore.set(pendingFoldersAtom, null);
            }
        }
    };
    writing = writing.then(run, run);
    return writing;
}

async function writeTabOrder(next: string[]): Promise<void> {
    const ws = globalStore.get(atoms.workspace);
    if (ws == null || sameOrder(next, ws.tabids ?? [])) {
        return;
    }
    try {
        await RpcApi.UpdateWorkspaceTabIdsCommand(TabRpcClient, ws.oid, next);
    } catch (e) {
        console.log("ordering the views of a folder", e);
    }
}

function tabOrder(): string[] {
    return [...(globalStore.get(atoms.workspace)?.tabids ?? [])];
}

function viewName(tabId: string): string {
    const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
    return tab == null ? "" : viewDisplayName(tab);
}

// The Views list's own tabs, in order.
function listTabs(): string[] {
    return globalStore.get(SidebarModel.getInstance().tabSplitAtom)?.temporary ?? [];
}

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

// The tab after the Views list's last one in the workspace's order: what a drop at the list's end lands before.
function followingTab(order: string[]): string {
    const list = listTabs();
    const last = list[list.length - 1];
    const at = order.indexOf(last);
    return at >= 0 && at + 1 < order.length ? order[at + 1] : null;
}

// The anchor of a folder in the list: the tab a drop before the folder lands before.
export function anchorOfFolder(folderId: string): string {
    const folder = currentFolders().find((f) => f.id === folderId);
    return folder == null ? null : folderAnchor(listTabs(), folder.tabids);
}

// How many other views a view's menu offers to make a folder with: the nearest ones in the list.
const MaxPartners = 12;

// What a view's menu offers about folders, read when the menu opens (FR-SHELL-080): the loose views of the list nearest
// to it, the folders it is not in, and taking it out of its own.
export function folderMenuFor(tabId: string): ViewMenuFolderHooks {
    const folders = currentFolders();
    const list = listTabs();
    const own = folderOf(folders, tabId);
    const loose = closableViews(list, folders).filter((id) => id !== tabId);
    const at = list.indexOf(tabId);
    const partners =
        own != null ? [] : [...loose].sort((a, b) => Math.abs(list.indexOf(a) - at) - Math.abs(list.indexOf(b) - at));
    return {
        partners: partners.slice(0, MaxPartners).map((id) => ({ tabId: id, name: viewName(id) })),
        folders: shownFolders(list, folders)
            .filter((f) => f.id !== own?.id)
            .map((f) => ({ id: f.id, name: f.name || t("sidebar.folders.name.mixed") })),
        make: (partner) => fireAndForget(() => dropViewOnView(tabId, partner)),
        join: (folderId) => fireAndForget(() => addViewToFolder(folderId, tabId)),
        takeOut: own == null ? undefined : () => fireAndForget(() => takeViewOut(tabId)),
    };
}

// Views that closed for good or were pinned leave their folders, and a folder left with one view dissolves. A view set
// aside for its Undo keeps its place: it is still a tab of the workspace.
export function pruneStoredFolders(): void {
    const folders = currentFolders();
    if (folders.length === 0) {
        return;
    }
    const ws = globalStore.get(atoms.workspace);
    const split = globalStore.get(SidebarModel.getInstance().tabSplitAtom);
    const pinned = new Set([...(split?.tiles ?? []), ...Object.values(split?.everywhere ?? {})]);
    const live = new Set((ws?.tabids ?? []).filter((id) => !pinned.has(id)));
    const next = pruneViewFolders(folders, live);
    if (sameViewFolders(next, folders)) {
        return;
    }
    if (globalStore.get(openFolderAtom) != null && !next.some((f) => f.id === globalStore.get(openFolderAtom))) {
        closeFolder();
    }
    fireAndForget(() => writeFolders(next));
}
