// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The renderer's side of the sites' icons (#1962, FR-SHELL-081 AC21-AC29, FR-BRW-019 AC11, DS-SHELL-126): Electron main keeps
// one icon per origin on disk (emain/moltenterm-favicons.ts) and tells every window when one changes; this keeps what the
// window draws in memory, as one atom. A view, a bookmark or a menu asks for the origins it shows (requestFavicons) and
// draws what is known, the generic web icon for an origin whose icon was never kept. Every call degrades to "nothing known"
// where the Electron API is missing (the preview server, a test) or fails: an icon is a convenience, never a reason for a
// list to break.

import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { atom, useAtomValue, type PrimitiveAtom } from "jotai";
import { measureDark } from "./favicon-dark";

// must match FaviconAnswer in emain/moltenterm-favicon-wire.ts
export type SiteIcon = { url: string; dark?: boolean };

type FaviconElectronApi = {
    moltentermFaviconRead?: (origins: string[]) => Promise<Record<string, SiteIcon>>;
    moltentermFaviconMeasured?: (origin: string, dark: boolean) => Promise<boolean>;
    moltentermFaviconCapture?: (webContentsId: number) => Promise<boolean>;
    onMoltentermFaviconChanged?: (
        callback: (change: { origin: string; url: string; dark?: boolean }) => void
    ) => () => void;
    onMoltentermFaviconsCleared?: (callback: () => void) => () => void;
};

function faviconApi(): FaviconElectronApi {
    return (typeof window === "undefined" ? {} : (getApi() ?? {})) as FaviconElectronApi;
}

export const faviconsAtom = atom({}) as PrimitiveAtom<Record<string, SiteIcon>>;
// The web page panels that are loading a page now, by block: the previous icon stays until the new page says its own.
export const siteLoadsAtom = atom({}) as PrimitiveAtom<Record<string, boolean>>;

const asked = new Set<string>();
let pending = new Set<string>();
let flushQueued = false;

function setIcon(origin: string, icon: SiteIcon) {
    const all = globalStore.get(faviconsAtom);
    const known = all[origin];
    if (known != null && known.url === icon.url && known.dark === icon.dark) {
        return;
    }
    globalStore.set(faviconsAtom, { ...all, [origin]: icon });
}

// An icon main sends without the dark measure is measured here, once, and the answer is kept with the icon.
async function measureAndKeep(origin: string, url: string) {
    const dark = await measureDark(url);
    if (dark == null) {
        return;
    }
    const known = globalStore.get(faviconsAtom)[origin];
    if (known == null || known.url !== url) {
        return;
    }
    setIcon(origin, { url, dark });
    try {
        await faviconApi().moltentermFaviconMeasured?.(origin, dark);
    } catch (e) {
        console.log("favicons: keeping the measure failed", e);
    }
}

function keep(origin: string, icon: SiteIcon) {
    setIcon(origin, icon);
    if (icon.dark == null) {
        void measureAndKeep(origin, icon.url);
    }
}

async function flush() {
    flushQueued = false;
    const origins = Array.from(pending);
    pending = new Set();
    const read = faviconApi().moltentermFaviconRead;
    if (read == null || origins.length === 0) {
        return;
    }
    try {
        const found = (await read(origins)) ?? {};
        for (const [origin, icon] of Object.entries(found)) {
            if (icon != null && typeof icon.url === "string") {
                keep(origin, icon);
            }
        }
    } catch (e) {
        console.log("favicons: read failed", e);
    }
}

// The origins a view, a bookmark or a menu is about to draw: asked of main once each, in one call, unless a change
// reaches this window first. Safe to call while rendering: the answer comes later.
export function requestFavicons(origins: readonly string[]): void {
    for (const origin of origins) {
        if (origin && !asked.has(origin)) {
            asked.add(origin);
            pending.add(origin);
        }
    }
    if (pending.size > 0 && !flushQueued) {
        flushQueued = true;
        queueMicrotask(() => void flush());
    }
}

export function noteFaviconChanged(change: { origin: string; url: string; dark?: boolean }): void {
    if (change == null || typeof change.origin !== "string" || typeof change.url !== "string") {
        return;
    }
    asked.add(change.origin);
    keep(change.origin, change.dark == null ? { url: change.url } : { url: change.url, dark: change.dark });
}

// Main cleared what it keeps: this window forgets what it drew too, and asks again for what it shows next.
export function noteFaviconsCleared(): void {
    asked.clear();
    pending = new Set();
    globalStore.set(faviconsAtom, {});
}

export function noteSiteLoading(blockId: string, loading: boolean): void {
    const all = globalStore.get(siteLoadsAtom);
    if (!!all[blockId] === loading) {
        return;
    }
    const next = { ...all };
    if (loading) {
        next[blockId] = true;
    } else {
        delete next[blockId];
    }
    globalStore.set(siteLoadsAtom, next);
}

// A bookmark added from a page that has an icon: main reads the icon of that page if it did not yet.
export function captureFavicon(webContentsId: number): void {
    if (typeof webContentsId !== "number") {
        return;
    }
    faviconApi()
        .moltentermFaviconCapture?.(webContentsId)
        ?.catch((e) => console.log("favicons: capture failed", e));
}

let started = false;

// Once per window: the icons main keeps from now on reach this window as they are read.
export function startFaviconCache(): void {
    if (started) {
        return;
    }
    started = true;
    faviconApi().onMoltentermFaviconChanged?.(noteFaviconChanged);
    faviconApi().onMoltentermFaviconsCleared?.(noteFaviconsCleared);
}

export function useSiteIcons(): Record<string, SiteIcon> {
    return useAtomValue(faviconsAtom);
}

export function resetFaviconCacheForTest(): void {
    asked.clear();
    pending = new Set();
    flushQueued = false;
    started = false;
    globalStore.set(faviconsAtom, {});
    globalStore.set(siteLoadsAtom, {});
}
