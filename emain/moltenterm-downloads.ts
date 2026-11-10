// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The downloads of the web pages in Electron main (FR-MC-019 AC7-AC13, #1992): every session, the default one and each
// partition created later, hands its downloads to the DownloadManager (moltenterm-download-manager.ts), which keeps
// the record of each one, saves it straight to the system Downloads folder without a native dialog (unless the user
// turned "always ask where to save" on), tells the windows and answers their questions. The Files panel's Download of a
// file on a connection is listed the same way (#2163); any other download of MoltenTerm's own interface is left to the
// engine as before.

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { randomUUID } from "crypto";
import * as electron from "electron";
import * as fs from "fs";
import * as path from "path";
import {
    connectionOfRemoteUri,
    DownloadActions,
    DownloadActRequest,
} from "../frontend/moltenterm-shell/downloads/downloads-model";
import { callWithOriginalXdgCurrentDesktopAsync, getWaveDataDir } from "./emain-platform";
import { getWaveTabViewByWebContentsId } from "./emain-tabview";
import { focusedWaveWindow, getWaveWindowById } from "./emain-window";
import { webviewOwner } from "./moltenterm-browseragent";
import { isHeld, takeAgentDownload } from "./moltenterm-download-hold";
import { DownloadManager, DownloadSource, ItemLike } from "./moltenterm-download-manager";
import { markDownloadedFile, realMarkDeps } from "./moltenterm-download-mark";
import { DownloadStore } from "./moltenterm-download-store";
import { isPanelPopup, popupGuestOf } from "./moltenterm-popups";
import { handleAppIpc } from "./moltenterm-privileged-ipc";

// The windows reach these through emain/preload.ts (moltentermDownloads*): keep the names in step.
export const DownloadsListChannel = "moltenterm-downloads-list";
export const DownloadsActChannel = "moltenterm-downloads-act";
export const DownloadsClearChannel = "moltenterm-downloads-clear";
export const DownloadsCheckChannel = "moltenterm-downloads-check";
// main -> every window: the whole list, throttled while bytes arrive
export const DownloadsChangedChannel = "moltenterm-downloads-changed";
// main -> the window that hosts the page: one finished or failed download to tell
export const DownloadsNotifyChannel = "moltenterm-downloads-notify";

const HistoryFolder = "downloads";
export const AskWhereSettingKey = "browser:downloadask";

let manager: DownloadManager = null;
let askWhere = false;
const hookedSessions = new WeakSet<electron.Session>();

export function noteDownloadSettings(settings: Record<string, unknown>): void {
    askWhere = settings?.[AskWhereSettingKey] === true;
}

// MoltenTerm's own windows, not a page and not DevTools.
function appRenderers(): electron.WebContents[] {
    return electron.webContents
        .getAllWebContents()
        .filter((c) => !c.isDestroyed() && c.getType() !== "webview" && !c.getURL().startsWith("devtools:"));
}

function sendToWindows(channel: string, ...args: unknown[]): void {
    for (const contents of appRenderers()) {
        contents.send(channel, ...args);
    }
}

// The window that hosts the page tells the user; when it is gone, the one in front does.
function windowToTell(hostId: number): electron.WebContents {
    const host = hostId > 0 ? electron.webContents.fromId(hostId) : null;
    if (host != null && !host.isDestroyed()) {
        return host;
    }
    const front = focusedWaveWindow?.activeTabView?.webContents;
    if (front != null && !front.isDestroyed()) {
        return front;
    }
    return appRenderers()[0] ?? null;
}

const NoSource: DownloadSource = { web: false, origin: {}, hostId: 0, agent: "", startAgain: () => false };

// The Files panel's Download (#2163): emain-ipc.ts names the stream address it is about to fetch, and the session's
// will-download that follows lists it like a page's download. Each address is expected once per click.
const expectedFiles = new Map<string, string[]>();

export function expectFileDownload(streamingUrl: string, remoteUri: string): void {
    expectedFiles.set(streamingUrl, [...(expectedFiles.get(streamingUrl) ?? []), remoteUri]);
}

function takeExpectedFile(url: string): string {
    const waiting = expectedFiles.get(url);
    if (waiting == null || waiting.length === 0) {
        return null;
    }
    const [uri, ...rest] = waiting;
    if (rest.length === 0) {
        expectedFiles.delete(url);
    } else {
        expectedFiles.set(url, rest);
    }
    return uri;
}

function describeFileSource(wc: electron.WebContents, remoteUri: string): DownloadSource {
    const session = wc.session;
    return {
        web: true,
        origin: { pageTitle: remoteUri },
        hostId: wc.id,
        agent: "",
        startAgain: (address) => {
            session.downloadURL(address);
            return true;
        },
        files: { connection: connectionOfRemoteUri(remoteUri) },
    };
}

// What the engine says about a download is the page that started it: a panel's page (or a popup it opened), whatever
// registered the page tells where it lives.
function describeSource(wc: electron.WebContents, url: string): DownloadSource {
    if (wc == null || wc.isDestroyed()) {
        return NoSource;
    }
    const guest = wc.getType() === "webview" ? wc : isPanelPopup(wc.id) ? popupGuestOf(wc.id) : null;
    if (guest == null || guest.isDestroyed()) {
        return NoSource;
    }
    const owner = webviewOwner(guest.id);
    const host = guest.hostWebContents;
    const tabView = host == null ? null : getWaveTabViewByWebContentsId(host.id);
    const waveWindow = tabView == null ? null : getWaveWindowById(tabView.waveWindowId);
    const session = wc.session;
    return {
        web: true,
        origin: {
            workspaceId: owner?.workspaceId || waveWindow?.workspaceId || "",
            tabId: owner?.tabId || tabView?.waveTabId || "",
            blockId: owner?.blockId ?? "",
            browserTabId: owner?.browserTabId ?? "",
            pageUrl: wc.getURL(),
            pageTitle: wc.getTitle(),
        },
        hostId: host?.id ?? 0,
        agent: takeAgentDownload(guest.id, url),
        startAgain: (address) => {
            (session ?? electron.session.defaultSession).downloadURL(address);
            return true;
        },
    };
}

function hookSession(session: electron.Session): void {
    if (session == null || hookedSessions.has(session) || manager == null) {
        return;
    }
    hookedSessions.add(session);
    // The downloads module listens before the agents' one (moltenterm-browseragent.ts hooks a session when a tab comes
    // under control): it cannot know yet whether that one holds the download back, so it asks again after every
    // listener ran.
    session.on("will-download", (event, item, wc) => {
        const url = item.getURLChain()[0] || item.getURL();
        const remoteUri = wc != null && !wc.isDestroyed() ? takeExpectedFile(url) : null;
        const source = remoteUri != null ? describeFileSource(wc, remoteUri) : describeSource(wc, url);
        manager.willDownload(event, item as unknown as ItemLike, source);
    });
}

function validRequest(value: unknown): DownloadActRequest {
    const req = value as DownloadActRequest;
    if (req == null || typeof req !== "object" || !DownloadActions.includes(req.action)) {
        return null;
    }
    if (req.id != null && (typeof req.id !== "string" || req.id.length > 100)) {
        return null;
    }
    return { action: req.action, id: req.id, confirmed: req.confirmed === true };
}

function makeManager(): DownloadManager {
    const store = new DownloadStore(path.join(getWaveDataDir(), HistoryFolder));
    return new DownloadManager({
        store,
        // MOLTENTERM_DOWNLOADS_DIR is for a test instance (UPSTREAM.md, "Test instances"): its downloads must not land in the
        // developer's own Downloads folder.
        folder: () => process.env.MOLTENTERM_DOWNLOADS_DIR || electron.app.getPath("downloads"),
        askWhere: () => askWhere,
        exists: (file) => fs.existsSync(file),
        statMode: (file) =>
            fs.promises
                .stat(file)
                .then((s) => s.mode)
                .catch(() => null),
        now: () => Date.now(),
        newId: () => randomUUID(),
        platform: process.platform,
        mark: (file, url, pageUrl) => markDownloadedFile(realMarkDeps, file, url, pageUrl, Date.now(), randomUUID()),
        openPath: async (file) => {
            let failed = "";
            await callWithOriginalXdgCurrentDesktopAsync(async () => {
                failed = await electron.shell.openPath(file);
            });
            return failed;
        },
        showItem: (file) => electron.shell.showItemInFolder(file),
        broadcast: (snapshot) => sendToWindows(DownloadsChangedChannel, snapshot),
        tell: (hostId, record, outcome) => windowToTell(hostId)?.send(DownloadsNotifyChannel, { record, outcome }),
        startAgain: (address) => {
            electron.session.defaultSession.downloadURL(address);
            return true;
        },
        isHeld: (item) => isHeld(item),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    });
}

export function initMoltentermDownloads(fullConfig: { settings?: unknown }): void {
    if (manager != null) {
        return;
    }
    noteDownloadSettings(fullConfig?.settings as Record<string, unknown>);
    manager = makeManager();
    void manager.restore();
    handleAppIpc(DownloadsListChannel, () => manager.snapshot());
    handleAppIpc(DownloadsActChannel, async (_event, request: unknown) => {
        const valid = validRequest(request);
        return valid == null ? { ok: false, error: "failed" } : manager.act(valid);
    });
    handleAppIpc(DownloadsClearChannel, () => manager.clear());
    handleAppIpc(DownloadsCheckChannel, async () => {
        await manager.check();
        return manager.snapshot();
    });
    hookSession(electron.session.defaultSession);
    electron.app.on("session-created", (session) => hookSession(session));
    electron.app.on("before-quit", () => manager.flushSync());
    electron.app.on("will-quit", () => manager.flushSync());
    waveEventSubscribeSingle({
        eventType: "config",
        handler: (event) => {
            const settings = (event?.data as { fullconfig?: { settings?: unknown } })?.fullconfig?.settings;
            if (settings != null) {
                noteDownloadSettings(settings as Record<string, unknown>);
            }
        },
    });
}
