// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    captureFavicon,
    faviconsAtom,
    noteFaviconChanged,
    noteSiteLoading,
    requestFavicons,
    resetFaviconCacheForTest,
    siteLoadsAtom,
    startFaviconCache,
} from "./favicon-store";

const measured = vi.hoisted(() => ({ dark: false as boolean | null }));
vi.mock("./favicon-dark", () => ({ measureDark: async () => measured.dark }));

const Notion = "https://notion.so";
const Linear = "https://linear.app";

type Api = Record<string, any>;
function installApi(api: Api) {
    (globalThis as any).window = { api };
}

// Everything async here settles within a few turns of the microtask queue.
async function settle() {
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
    }
}

beforeEach(() => {
    resetFaviconCacheForTest();
    measured.dark = false;
});

afterEach(() => {
    delete (globalThis as any).window;
});

describe("the window's sites' icons", () => {
    it("asks Electron main once, in one call, for the origins it is about to draw", async () => {
        const read = vi.fn(async (origins: string[]) => ({
            [Notion]: { url: "data:image/png;base64,AAAA", dark: false },
        }));
        installApi({ moltentermFaviconRead: read });
        requestFavicons([Notion, Linear, Notion, ""]);
        requestFavicons([Notion]);
        await settle();
        expect(read).toHaveBeenCalledTimes(1);
        expect(read.mock.calls[0][0].sort()).toEqual([Linear, Notion].sort());
        expect(globalStore.get(faviconsAtom)).toEqual({ [Notion]: { url: "data:image/png;base64,AAAA", dark: false } });
        requestFavicons([Notion, Linear]);
        await settle();
        expect(read).toHaveBeenCalledTimes(1);
    });

    it("knows nothing, and does not fail, where there is no Electron API or the read fails", async () => {
        requestFavicons([Notion]);
        await settle();
        expect(globalStore.get(faviconsAtom)).toEqual({});
        resetFaviconCacheForTest();
        installApi({
            moltentermFaviconRead: async () => {
                throw new Error("gone");
            },
        });
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        requestFavicons([Linear]);
        await settle();
        expect(globalStore.get(faviconsAtom)).toEqual({});
        log.mockRestore();
    });

    it("measures an icon main sent without a measure, once, and gives the answer back to main", async () => {
        measured.dark = true;
        const kept = vi.fn(async () => true);
        installApi({
            moltentermFaviconRead: async () => ({ [Notion]: { url: "data:image/png;base64,AAAA" } }),
            moltentermFaviconMeasured: kept,
        });
        requestFavicons([Notion]);
        await settle();
        expect(globalStore.get(faviconsAtom)[Notion]).toEqual({ url: "data:image/png;base64,AAAA", dark: true });
        expect(kept).toHaveBeenCalledWith(Notion, true);
    });

    it("does not measure an icon that arrives with its measure, and ignores an image that cannot be decoded", async () => {
        const kept = vi.fn(async () => true);
        installApi({ moltentermFaviconMeasured: kept });
        noteFaviconChanged({ origin: Notion, url: "data:image/png;base64,AAAA", dark: false });
        await settle();
        expect(kept).not.toHaveBeenCalled();
        measured.dark = null;
        noteFaviconChanged({ origin: Linear, url: "data:image/png;base64,BBBB" });
        await settle();
        expect(kept).not.toHaveBeenCalled();
        expect(globalStore.get(faviconsAtom)[Linear]).toEqual({ url: "data:image/png;base64,BBBB" });
    });

    it("takes an icon main announces, once the window listens", async () => {
        let listener: (change: any) => void = null;
        const unlisten = vi.fn();
        installApi({
            onMoltentermFaviconChanged: (cb: (change: any) => void) => {
                listener = cb;
                return unlisten;
            },
            moltentermFaviconMeasured: async () => true,
        });
        startFaviconCache();
        startFaviconCache();
        listener({ origin: Linear, url: "data:image/png;base64,CCCC", dark: false });
        expect(globalStore.get(faviconsAtom)[Linear].url).toBe("data:image/png;base64,CCCC");
        listener({ origin: 4, url: null });
        listener(null);
        expect(Object.keys(globalStore.get(faviconsAtom))).toEqual([Linear]);
    });

    it("forgets every icon when main clears them, and asks again for what it shows next", async () => {
        let cleared: () => void = null;
        const read = vi.fn(async () => ({}));
        installApi({
            moltentermFaviconRead: read,
            moltentermFaviconMeasured: async () => true,
            onMoltentermFaviconsCleared: (cb: () => void) => {
                cleared = cb;
                return () => {};
            },
        });
        startFaviconCache();
        noteFaviconChanged({ origin: Notion, url: "data:image/png;base64,AAAA", dark: false });
        cleared();
        expect(globalStore.get(faviconsAtom)).toEqual({});
        requestFavicons([Notion]);
        await settle();
        expect(read).toHaveBeenCalledWith([Notion]);
    });

    it("replaces an icon whose image changed and leaves one that did not", () => {
        installApi({ moltentermFaviconMeasured: async () => true });
        noteFaviconChanged({ origin: Notion, url: "data:image/png;base64,AAAA", dark: false });
        const first = globalStore.get(faviconsAtom);
        noteFaviconChanged({ origin: Notion, url: "data:image/png;base64,AAAA", dark: false });
        expect(globalStore.get(faviconsAtom)).toBe(first);
        noteFaviconChanged({ origin: Notion, url: "data:image/png;base64,ZZZZ", dark: false });
        expect(globalStore.get(faviconsAtom)[Notion].url).toBe("data:image/png;base64,ZZZZ");
    });

    it("tracks the panels that are loading a page, and forgets them when the load ends", () => {
        noteSiteLoading("blk-a", true);
        noteSiteLoading("blk-b", true);
        noteSiteLoading("blk-a", true);
        expect(globalStore.get(siteLoadsAtom)).toEqual({ "blk-a": true, "blk-b": true });
        noteSiteLoading("blk-a", false);
        noteSiteLoading("blk-a", false);
        expect(globalStore.get(siteLoadsAtom)).toEqual({ "blk-b": true });
    });

    it("asks main to read a page's icon for a bookmark, for a page's id only", async () => {
        const capture = vi.fn(async () => true);
        installApi({ moltentermFaviconCapture: capture });
        captureFavicon(42);
        captureFavicon("42" as any);
        captureFavicon(undefined);
        await settle();
        expect(capture).toHaveBeenCalledTimes(1);
        expect(capture).toHaveBeenCalledWith(42);
    });
});
