// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The folders of views of the window's workspace (FR-SHELL-080, #2484): read from the workspace's meta and written back
// with the helpers below. What the Views list draws and what a drag reads is here, in the startup bundle; what changes
// a folder (view-folders-ops.ts) and the folders' row and grid (view-folders-ui.tsx) load on demand (NFR-PERF-003). A
// write is read back from wavesrv before its pending value goes (as the sidebar's own meta writes are), so that two
// changes in a row never start from a stale list. The rules are in view-folders-model.ts.

import { atoms, globalStore, WOS } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import * as jotai from "jotai";
import { t } from "../i18n/i18n";
import { viewDisplayName } from "../tab-identity-ui";
import { SidebarModel } from "./sidebar-store";
import {
    closableViews,
    folderAnchor,
    folderOf,
    pruneViewFolders,
    readViewFolders,
    sameViewFolders,
    shownFolders,
    ViewFolder,
    ViewFoldersMetaKey,
} from "./view-folders-model";
import type { ViewMenuFolderHooks } from "./view-menu";
import { sameOrder } from "./view-menu-model";

// The operations that change a folder, loaded the first time one is done.
export const loadFolderOps = () => import("./view-folders-ops");

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

export function currentFolders(): ViewFolder[] {
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
export function writeFolders(next: ViewFolder[]): Promise<void> {
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

export async function writeTabOrder(next: string[]): Promise<void> {
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

export function tabOrder(): string[] {
    return [...(globalStore.get(atoms.workspace)?.tabids ?? [])];
}

export function viewName(tabId: string): string {
    const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
    return tab == null ? "" : viewDisplayName(tab);
}

// The Views list's own tabs, in order.
export function listTabs(): string[] {
    return globalStore.get(SidebarModel.getInstance().tabSplitAtom)?.temporary ?? [];
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
        make: (partner) => fireAndForget(async () => (await loadFolderOps()).dropViewOnView(tabId, partner)),
        join: (folderId) => fireAndForget(async () => (await loadFolderOps()).addViewToFolder(folderId, tabId)),
        takeOut: own == null ? undefined : () => fireAndForget(async () => (await loadFolderOps()).takeViewOut(tabId)),
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
