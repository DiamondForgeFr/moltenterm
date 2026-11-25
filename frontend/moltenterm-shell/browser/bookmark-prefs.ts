// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The two small preferences of the bookmark surfaces (#2531): the width the panel was dragged to and the places last
// added to, which the place finder offers when nothing is typed. They live in the client's meta, next to the bookmarks,
// and not in the window's storage, which is emptied at every restart (#1763). Only a window writes them.

import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/global";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { parsePlaceKey, placeKey, type PlaceRef } from "./bookmarks";

export const BookmarkPrefsMetaKey = "molten:bookmarkprefs";
export const RecentPlacesMax = 6;

// width: 0 until the panel has been dragged (it then opens at its default); recent: place keys, newest first.
export type BookmarkPrefs = { width: number; recent: string[] };

export const NoPrefs: BookmarkPrefs = { width: 0, recent: [] };

export function readPrefs(clientMeta: Record<string, any>): BookmarkPrefs {
    const raw = clientMeta?.[BookmarkPrefsMetaKey];
    if (raw == null || typeof raw !== "object") {
        return NoPrefs;
    }
    const width = typeof raw.width === "number" && Number.isFinite(raw.width) && raw.width > 0 ? Math.round(raw.width) : 0;
    const recent: string[] = [];
    for (const key of Array.isArray(raw.recent) ? raw.recent : []) {
        if (typeof key === "string" && parsePlaceKey(key) != null && !recent.includes(key)) {
            recent.push(key);
        }
    }
    return { width, recent: recent.slice(0, RecentPlacesMax) };
}

// The recent places once this one was used: it comes first, once.
export function withRecentPlace(recent: readonly string[], ref: PlaceRef): string[] {
    const key = placeKey(ref);
    return [key, ...recent.filter((k) => k !== key)].slice(0, RecentPlacesMax);
}

function prefsNow(): BookmarkPrefs {
    const atom = ClientModel.getInstance().clientAtom;
    return readPrefs(atom == null ? null : globalStore.get(atom)?.meta);
}

// The preferences are kept on a best effort: a write that fails costs a remembered width or a recent place, never a
// bookmark.
async function writePrefs(prefs: BookmarkPrefs): Promise<void> {
    const clientId = ClientModel.getInstance().clientId;
    if (clientId == null) {
        return;
    }
    try {
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: makeORef("client", clientId),
            meta: { [BookmarkPrefsMetaKey]: prefs } as MetaType,
        });
    } catch (e) {
        console.log("bookmarks: preferences not kept", e);
    }
}

export function noteRecentPlace(ref: PlaceRef): Promise<void> {
    const prefs = prefsNow();
    return writePrefs({ ...prefs, recent: withRecentPlace(prefs.recent, ref) });
}

export function savePanelWidth(width: number): Promise<void> {
    return writePrefs({ ...prefsNow(), width: Math.round(width) });
}
