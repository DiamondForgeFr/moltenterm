// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The sites' icons (#1962, FR-SHELL-081 AC21-AC29, FR-BRW-019 AC11, DS-SHELL-126): when a page declares an icon, Electron main
// reads it once, through the page's own session (the one the page loaded in, with the page's proxy and none of its
// cookies), checks it and keeps it per origin in the application's data folder (moltenterm-favicon-store.ts), then tells
// the windows. Nothing else is requested: no icon is guessed for a page that declares none, and no third party is asked.
// The windows read what is kept, so a view or a bookmark of a site drawn before its page loads, or never visited since,
// shows the generic web icon and not a broken image. A web panel's "clear cookies and storage" clears the store too.

import * as electron from "electron";
import * as path from "path";
import { getWaveDataDir } from "./emain-platform";
import { FaviconMaxBytes, FaviconStore } from "./moltenterm-favicon-store";
import {
    decodeInlineIcon,
    faviconAnswer,
    FaviconCaptureChannel,
    FaviconChangedChannel,
    FaviconMeasuredChannel,
    FaviconReadChannel,
    FaviconsClearedChannel,
    iconDataUrl,
    isDefaultIconAddress,
    isInlineIcon,
    originOfPage,
    parseFaviconOrigins,
    parseMeasured,
    pickIconAddress,
    sniffIcon,
} from "./moltenterm-favicon-wire";
import { handleAppIpc } from "./moltenterm-privileged-ipc";

const FaviconFolder = "favicons";
const FetchTimeoutMs = 8000;
// An isolated world: the page's own scripts neither see this check nor change what it answers.
const FaviconWorldId = 1302;
const DeclaresIconScript = `document.querySelector('link[rel~="icon" i]') != null`;

let store: FaviconStore = null;
const declared = new WeakMap<electron.WebContents, string[]>();
const reading = new Set<string>();

function logFailure(what: string, e: unknown) {
    console.log(`favicons: ${what} failed`, e instanceof Error ? e.message : String(e));
}

function faviconStore(): FaviconStore {
    if (store == null) {
        store = new FaviconStore(path.join(getWaveDataDir(), FaviconFolder));
    }
    return store;
}

// The body of an icon, read up to the cap and not a byte further.
async function readCapped(res: Awaited<ReturnType<electron.Session["fetch"]>>): Promise<Buffer> {
    const length = Number(res.headers.get("content-length"));
    if (Number.isFinite(length) && length > FaviconMaxBytes) {
        return null;
    }
    const reader = res.body?.getReader();
    if (reader == null) {
        return null;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        total += value.length;
        if (total > FaviconMaxBytes) {
            await reader.cancel();
            return null;
        }
        chunks.push(Buffer.from(value));
    }
    return total > 0 ? Buffer.concat(chunks) : null;
}

// The icon's bytes, through the session the page loaded in; the cache is asked first, as a page's own image is.
async function fetchIcon(session: electron.Session, address: string): Promise<Buffer> {
    const res = await session.fetch(address, {
        cache: "force-cache",
        credentials: "omit",
        redirect: "follow",
        signal: AbortSignal.timeout(FetchTimeoutMs),
    });
    return res.ok ? readCapped(res) : null;
}

async function iconBytes(wc: electron.WebContents, address: string): Promise<Buffer> {
    if (isInlineIcon(address)) {
        return decodeInlineIcon(address)?.data ?? null;
    }
    return fetchIcon(wc.session, address);
}

async function pageDeclaresIcon(wc: electron.WebContents): Promise<boolean> {
    return (await wc.executeJavaScriptInIsolatedWorld(FaviconWorldId, [{ code: DeclaresIconScript }])) === true;
}

function sendToWindows(channel: string, ...args: unknown[]) {
    for (const contents of electron.webContents.getAllWebContents()) {
        if (contents.isDestroyed() || contents.getType() === "webview" || contents.getURL().startsWith("devtools:")) {
            continue;
        }
        contents.send(channel, ...args);
    }
}

function tellWindows(origin: string, url: string, dark: boolean | undefined) {
    sendToWindows(FaviconChangedChannel, dark == null ? { origin, url } : { origin, url, dark });
}

// Keeps the icon the page declared. force: the caller asks for it again whatever was kept (a bookmark added from the
// page); otherwise an icon read recently at the same address is left as it is.
async function captureIcon(wc: electron.WebContents, force: boolean): Promise<boolean> {
    if (wc.isDestroyed()) {
        return false;
    }
    const origin = originOfPage(wc.getURL());
    const address = pickIconAddress(declared.get(wc));
    if (origin == null || address == null || reading.has(origin)) {
        return false;
    }
    reading.add(origin);
    try {
        if (!force && (await faviconStore().isFresh(origin, address))) {
            return false;
        }
        if (isDefaultIconAddress(address, origin) && !(await pageDeclaresIcon(wc))) {
            return false;
        }
        const data = await iconBytes(wc, address);
        const mime = data == null ? null : sniffIcon(data);
        if (data == null || mime == null || !(await faviconStore().put(origin, address, mime, data))) {
            return false;
        }
        tellWindows(origin, iconDataUrl({ data, mime }), undefined);
        return true;
    } catch (e) {
        logFailure("read", e);
        return false;
    } finally {
        reading.delete(origin);
    }
}

// Called for every web page guest: its icon is read when the page declares it, and again when it changes.
export function watchGuestFavicons(wc: electron.WebContents) {
    wc.on("page-favicon-updated", (_event, favicons) => {
        declared.set(wc, favicons);
        void captureIcon(wc, false);
    });
}

// A web panel's "clear cookies and storage": the sites' icons go with the rest, from the disk and from every window.
export async function clearFaviconCache(): Promise<number> {
    try {
        const count = await faviconStore().clear();
        sendToWindows(FaviconsClearedChannel);
        return count;
    } catch (e) {
        logFailure("clear", e);
        return 0;
    }
}

export function initMoltentermFavicons() {
    handleAppIpc(FaviconReadChannel, async (_event, origins) => {
        try {
            return faviconAnswer(await faviconStore().getMany(parseFaviconOrigins(origins)));
        } catch (e) {
            logFailure("read", e);
            return {};
        }
    });
    handleAppIpc(FaviconMeasuredChannel, async (_event, origin, dark) => {
        const measured = parseMeasured(origin, dark);
        if (measured == null) {
            return false;
        }
        try {
            return await faviconStore().setDark(measured.origin, measured.dark);
        } catch (e) {
            logFailure("measure", e);
            return false;
        }
    });
    // A bookmark added from a page that has an icon: the window names the page, and the icon is read for it if it was not.
    handleAppIpc(FaviconCaptureChannel, async (event, webContentsId) => {
        const wc = typeof webContentsId === "number" ? electron.webContents.fromId(webContentsId) : null;
        if (
            wc == null ||
            wc.isDestroyed() ||
            wc.getType() !== "webview" ||
            wc.hostWebContents?.id !== event.sender.id
        ) {
            return false;
        }
        return captureIcon(wc, true);
    });
}
