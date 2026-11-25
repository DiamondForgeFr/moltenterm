// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The writes of the bookmarks (FR-BRW-019, FR-BRW-021, #2531): each one reads the client's meta as it is now, applies a
// pure change from bookmarks.ts and saves the key in one meta write, so the popover, the column panel and the settings
// card, which read the same meta, follow at once. wavesrv never writes them (it only drops the places of a removed
// project, workspace or context, and migrates the bookmarks of the former per-project layout once).

import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/global";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import {
    addBookmark,
    addPage,
    Bookmark,
    BookmarkDraft,
    BookmarkProblem,
    BookmarkResult,
    BookmarksMetaKey,
    BookmarkStore,
    copyBookmarkTo,
    createFolder,
    deleteBookmark,
    deleteFolder,
    FolderChoice,
    moveBookmark,
    placeBookmark,
    PlaceRef,
    readStore,
    renameFolder,
    storeValue,
    unplaceBookmark,
    updateBookmark,
} from "./bookmarks";

export const SaveFailedProblem: BookmarkProblem = "browser.bookmarks.problem.notSaved";

type Change<T> = (store: BookmarkStore) => BookmarkResult<{ store: BookmarkStore; result: T }>;
export type Applied<T> = { problem: BookmarkProblem; result?: undefined } | { problem: null; result: T };

function latestClient(): Client {
    const atom = ClientModel.getInstance().clientAtom;
    return atom == null ? null : globalStore.get(atom);
}

// Every change rewrites the whole `molten:bookmarks` key from what it read, so two running together would erase each
// other: they run one after the other, and each reads the client again once the one before it has saved.
let queue: Promise<unknown> = Promise.resolve();

// The window's copy of the client follows a save a moment later: until a newer version of it arrives, the next change
// reads what the last one wrote, so it never starts from the older value. The server sends the versions in order, so the
// first newer one holds that write.
let saved: { oid: string; value: ReturnType<typeof storeValue>; version: number } = null;

function metaNow(client: Client): Record<string, any> {
    const meta = (client.meta ?? {}) as Record<string, any>;
    if (saved != null && saved.oid === client.oid && saved.version === client.version) {
        return { ...meta, [BookmarksMetaKey]: saved.value };
    }
    return meta;
}

async function applyChange<T>(change: Change<T>): Promise<Applied<T>> {
    const client = latestClient();
    if (client == null) {
        return { problem: SaveFailedProblem };
    }
    const changed = change(readStore(metaNow(client)));
    if (changed.problem != null) {
        return { problem: changed.problem };
    }
    const value = storeValue(changed.value.store);
    try {
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: makeORef("client", client.oid),
            meta: { [BookmarksMetaKey]: value } as MetaType,
        });
    } catch (e) {
        console.error("bookmarks: save failed", e);
        saved = null;
        return { problem: SaveFailedProblem };
    }
    saved = { oid: client.oid, value, version: client.version };
    return { problem: null, result: changed.value.result };
}

// Applies a change to the client's latest bookmarks. The answer is the problem to tell, or the change's result once saved.
export function changeBookmarks<T>(change: Change<T>): Promise<Applied<T>> {
    const run = queue.then(() => applyChange(change));
    queue = run.catch(() => null);
    return run;
}

function plain(change: (store: BookmarkStore) => BookmarkResult<BookmarkStore>): Change<null> {
    return (store) => {
        const result = change(store);
        return result.problem != null ? { problem: result.problem } : { value: { store: result.value, result: null } };
    };
}

async function problemOf(applied: Promise<Applied<unknown>>): Promise<BookmarkProblem> {
    return (await applied).problem;
}

// Adds a bookmark at one place (the folder of the choice, or a new one). Answers the bookmark made.
export function addBookmarkAt(
    draft: BookmarkDraft,
    ref: PlaceRef,
    choice: FolderChoice = {}
): Promise<Applied<Bookmark>> {
    return changeBookmarks((store) => {
        const added = addBookmark(store, draft, ref, choice);
        return added.problem != null
            ? { problem: added.problem }
            : { value: { store: added.value.store, result: added.value.bookmark } };
    });
}

// The shown page at one place (the panel's Add the page): an existing bookmark of that address is placed there too.
export function addPageAt(draft: BookmarkDraft, ref: PlaceRef, choice: FolderChoice = {}): Promise<Applied<Bookmark>> {
    return changeBookmarks((store) => {
        const added = addPage(store, draft, ref, choice);
        return added.problem != null
            ? { problem: added.problem }
            : { value: { store: added.value.store, result: added.value.bookmark } };
    });
}

// A separate bookmark with its own name, at one place.
export function copyBookmarkAt(id: string, ref: PlaceRef, choice: FolderChoice = {}): Promise<Applied<Bookmark>> {
    return changeBookmarks((store) => {
        const copied = copyBookmarkTo(store, id, ref, choice);
        return copied.problem != null
            ? { problem: copied.problem }
            : { value: { store: copied.value.store, result: copied.value.bookmark } };
    });
}

export function editBookmark(id: string, draft: BookmarkDraft): Promise<BookmarkProblem> {
    return problemOf(changeBookmarks(plain((store) => updateBookmark(store, id, draft))));
}

export function placeBookmarkAt(id: string, ref: PlaceRef, choice: FolderChoice = {}): Promise<BookmarkProblem> {
    return problemOf(changeBookmarks(plain((store) => placeBookmark(store, id, ref, choice))));
}

export function unplaceBookmarkAt(id: string, ref: PlaceRef): Promise<BookmarkProblem> {
    return problemOf(changeBookmarks(plain((store) => ({ value: unplaceBookmark(store, id, ref) }))));
}

export function moveBookmarkTo(
    id: string,
    from: PlaceRef,
    to: PlaceRef,
    choice: FolderChoice = {}
): Promise<BookmarkProblem> {
    return problemOf(changeBookmarks(plain((store) => moveBookmark(store, id, from, to, choice))));
}

export function removeBookmarkEverywhere(id: string): Promise<BookmarkProblem> {
    return problemOf(changeBookmarks(plain((store) => ({ value: deleteBookmark(store, id) }))));
}

export function createFolderAt(ref: PlaceRef, name: string): Promise<BookmarkProblem> {
    return problemOf(
        changeBookmarks((store) => {
            const created = createFolder(store, ref, name);
            return created.problem != null
                ? { problem: created.problem }
                : { value: { store: created.value.store, result: created.value.folder } };
        })
    );
}

export function renameFolderAt(ref: PlaceRef, folderId: string, name: string): Promise<BookmarkProblem> {
    return problemOf(changeBookmarks(plain((store) => renameFolder(store, ref, folderId, name))));
}

export function deleteFolderAt(ref: PlaceRef, folderId: string): Promise<BookmarkProblem> {
    return problemOf(changeBookmarks(plain((store) => ({ value: deleteFolder(store, ref, folderId) }))));
}
