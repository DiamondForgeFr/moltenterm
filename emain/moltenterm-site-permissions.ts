// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Permission handlers for every session (#663): pages outside MoltenTerm's own interface (the browser panel's tabs and
// their popups, Wave's web blocks) go through frontend/moltenterm-shell/browser/site-permission.ts. Without a handler
// Electron grants a page everything it asks for: camera, microphone, location, notifications, MIDI, HID, serial,
// external apps. MoltenTerm's own renderers keep Electron's default, since they are the app.
//
// A request that needs the user is asked in the panel tab the page belongs to (a popup asks in its opener's tab):
// main sends it to that tab's renderer, whose preload hands it to the tab's webview element; the panel's bar answers.
// A page outside the panel (a Wave web block) has no bar: it gets only the decisions already remembered.

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { randomUUID } from "crypto";
import * as electron from "electron";
import {
    checkPermission,
    classifyPermissionRequest,
    DecisionAllow,
    DecisionBlock,
    DecisionDismiss,
    permissionSite,
    rememberedVerdict,
    SitePermissionsKey,
    SitePermissionStore,
    validDecision,
    VerdictAllow,
    VerdictAsk,
    VerdictExternal,
    withDecision,
} from "../frontend/moltenterm-shell/browser/site-permission";
import { ElectronWshClient } from "./emain-wsh";
import { allowPageExternalLaunch } from "./moltenterm-external-links";
import { isPanelPopup, popupGuestOf } from "./moltenterm-popups";

// main -> the renderer holding the webview: (requestId, guestWebContentsId, site, kinds)
export const SitePermissionAskChannel = "moltenterm-site-permission-ask";
// renderer -> main: (requestId, decision)
export const SitePermissionAnswerChannel = "moltenterm-site-permission-answer";
// main -> the renderer: (requestId), the question is gone (answered elsewhere, timed out, page closed)
export const SitePermissionDoneChannel = "moltenterm-site-permission-done";

// A question nobody answers is refused after this long, so the page's promise settles.
const AskTimeoutMs = 5 * 60 * 1000;

type PendingAsk = {
    key: string;
    hostId: number;
    site: string;
    kinds: string[];
    answers: ((granted: boolean) => void)[];
    timer: ReturnType<typeof setTimeout>;
};

let store: SitePermissionStore = {};
const pending = new Map<string, PendingAsk>();
const pendingByKey = new Map<string, string>();
const hookedSessions = new WeakSet<electron.Session>();

export function noteSitePermissionSettings(settings: Record<string, unknown>): void {
    const value = settings?.[SitePermissionsKey];
    store = value != null && typeof value === "object" ? (value as SitePermissionStore) : {};
}

export function currentSitePermissions(): SitePermissionStore {
    return store;
}

// MoltenTerm's own renderers (tab views, the builder): neither a webview guest nor a popup a page opened.
export function isAppRenderer(wc: electron.WebContents): boolean {
    if (wc == null || wc.isDestroyed()) {
        return false;
    }
    return wc.getType() !== "webview" && !isPanelPopup(wc.id);
}

// The panel tab's webview a page belongs to: itself for a tab, its opener's tab for a popup.
function panelGuestOf(wc: electron.WebContents): electron.WebContents {
    if (wc.getType() === "webview") {
        return wc;
    }
    return popupGuestOf(wc.id);
}

function persist(next: SitePermissionStore): void {
    store = next;
    RpcApi.SetConfigCommand(ElectronWshClient, { [SitePermissionsKey]: next } as SettingsType).catch((e) =>
        console.log("site permissions: not saved", e)
    );
}

function finish(requestId: string, decision: string): void {
    const ask = pending.get(requestId);
    if (ask == null) {
        return;
    }
    pending.delete(requestId);
    pendingByKey.delete(ask.key);
    clearTimeout(ask.timer);
    if (decision === DecisionAllow || decision === DecisionBlock) {
        persist(withDecision(store, ask.site, ask.kinds, decision));
    }
    const host = electron.webContents.fromId(ask.hostId);
    if (host != null && !host.isDestroyed()) {
        host.send(SitePermissionDoneChannel, requestId);
    }
    for (const answer of ask.answers) {
        answer(decision === DecisionAllow);
    }
}

function ask(guest: electron.WebContents, site: string, kinds: string[]): Promise<boolean> {
    const host = guest.hostWebContents;
    if (host == null || host.isDestroyed()) {
        return Promise.resolve(false);
    }
    const key = `${guest.id}|${site}|${kinds.join(",")}`;
    return new Promise((resolve) => {
        const existing = pendingByKey.get(key);
        if (existing != null && pending.has(existing)) {
            pending.get(existing).answers.push(resolve);
            return;
        }
        const requestId = randomUUID();
        pending.set(requestId, {
            key,
            hostId: host.id,
            site,
            kinds,
            answers: [resolve],
            timer: setTimeout(() => finish(requestId, DecisionDismiss), AskTimeoutMs),
        });
        pendingByKey.set(key, requestId);
        guest.once("destroyed", () => finish(requestId, DecisionDismiss));
        host.send(SitePermissionAskChannel, requestId, guest.id, site, kinds);
    });
}

export async function decidePageRequest(
    wc: electron.WebContents,
    permission: string,
    details: { requestingUrl?: string; mediaTypes?: unknown; externalURL?: string }
): Promise<boolean> {
    const rule = classifyPermissionRequest(permission, details);
    if (rule.verdict === VerdictAllow) {
        return true;
    }
    if (rule.verdict === VerdictExternal) {
        return allowPageExternalLaunch(details?.externalURL, wc);
    }
    if (rule.verdict !== VerdictAsk) {
        console.log("site permission denied", permission);
        return false;
    }
    const site = permissionSite(details?.requestingUrl || wc.getURL());
    const remembered = rememberedVerdict(store, site, rule.kinds);
    if (remembered.verdict !== VerdictAsk) {
        return remembered.verdict === VerdictAllow;
    }
    const guest = panelGuestOf(wc);
    if (guest == null || guest.isDestroyed()) {
        return false;
    }
    return ask(guest, site, remembered.kinds);
}

function hookSession(session: electron.Session): void {
    if (session == null || hookedSessions.has(session)) {
        return;
    }
    hookedSessions.add(session);
    session.setPermissionRequestHandler((wc, permission, callback, details) => {
        if (isAppRenderer(wc)) {
            callback(true);
            return;
        }
        if (wc == null || wc.isDestroyed()) {
            callback(false);
            return;
        }
        decidePageRequest(wc, permission, details as any).then(callback, (e) => {
            console.log("site permission error", e);
            callback(false);
        });
    });
    session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
        if (wc != null && isAppRenderer(wc)) {
            return true;
        }
        return checkPermission(store, permission, requestingOrigin, (details as any)?.mediaType);
    });
    // Pages never reach USB, HID or serial devices.
    session.setDevicePermissionHandler(() => false);
}

export function initMoltentermSitePermissions(fullConfig: FullConfigType): void {
    noteSitePermissionSettings(fullConfig?.settings as Record<string, unknown>);
    waveEventSubscribeSingle({
        eventType: "config",
        handler: (event) => {
            const settings = (event?.data as { fullconfig?: FullConfigType })?.fullconfig?.settings;
            if (settings != null) {
                noteSitePermissionSettings(settings as Record<string, unknown>);
            }
        },
    });
}

// Before any window: every session, the default one and each partition created later, gets the handlers.
export function installMoltentermSitePermissionHandlers(): void {
    hookSession(electron.session.defaultSession);
    electron.app.on("session-created", (session) => hookSession(session));
    electron.ipcMain.on(SitePermissionAnswerChannel, (event, requestId: unknown, decision: unknown) => {
        if (typeof requestId !== "string") {
            return;
        }
        const ask = pending.get(requestId);
        if (ask == null || ask.hostId !== event.sender.id) {
            return;
        }
        finish(requestId, validDecision(decision));
    });
}
