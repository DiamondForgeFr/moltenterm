// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { ipcMain, screen, webContents, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { getBuilderWindowByWebContentsId } from "./emain-builder";
import { getWaveWindowByWebContentsId } from "./emain-window";
import { contextMenuRole, ownedMenuGuest, supportedMenuImage } from "./moltenterm-contextmenu-policy";

type Target = {
    host: WebContents;
    target: WebContents;
    expires: number;
    url: string;
    revoked: boolean;
    generation: number;
    hostGeneration: number;
};
export const ContextMenuEvents = new EventEmitter();
const targets = new Map<string, Target>();
const images = new Map<string, Target & { source: string }>();
const activeGuests = new Map<number, Set<number>>();
const watched = new Set<number>();
const generations = new Map<number, number>();
const watchedWindows = new Set<number>();
const leaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
function dropLease<T extends Target>(map: Map<string, T>, token: string, revoke = true): T {
    const target = map.get(token);
    clearTimeout(leaseTimers.get(token));
    leaseTimers.delete(token);
    if (target && revoke) target.revoked = true;
    map.delete(token);
    return target;
}
function retainLease<T extends Target>(map: Map<string, T>, token: string, target: T) {
    map.set(token, target);
    const timer = setTimeout(() => {
        dropLease(map, token);
    }, 60000);
    timer.unref();
    leaseTimers.set(token, timer);
}
export function contextMenuWindow(host: WebContents) {
    return getWaveWindowByWebContentsId(host?.id) ?? getBuilderWindowByWebContentsId(host?.id);
}
export function liveContextMenuHost(host: WebContents, requireFocus = true): boolean {
    if (!host || host.isDestroyed() || host.getType() === "webview") return false;
    const window = getWaveWindowByWebContentsId(host.id);
    if (window)
        return (
            !window.isDestroyed() && (!requireFocus || window.isFocused()) && window.activeTabView?.webContents === host
        );
    const builder = getBuilderWindowByWebContentsId(host.id);
    return (
        !!builder && !builder.isDestroyed() && (!requireFocus || builder.isFocused()) && builder.webContents === host
    );
}
function live(target: Target, host: WebContents): boolean {
    if (!target || target.revoked || target.host !== host || target.expires < Date.now() || !liveContextMenuHost(host))
        return false;
    if (
        target.generation !== (generations.get(target.target.id) ?? 0) ||
        target.hostGeneration !== (generations.get(host.id) ?? 0)
    )
        return false;
    if (target.target === host) return true;
    return (
        ownedMenuGuest(host, target.target) &&
        activeGuests.get(host.id)?.has(target.target.id) &&
        target.target.getURL() === target.url
    );
}
function clearFor(contents: WebContents) {
    generations.set(contents.id, (generations.get(contents.id) ?? 0) + 1);
    for (const map of [targets, images]) {
        for (const [token, target] of map) {
            if (target.host !== contents && target.target !== contents) continue;
            dropLease(map, token);
        }
    }
}
function watch(contents: WebContents) {
    if (watched.has(contents.id)) return;
    watched.add(contents.id);
    contents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
        if (mainFrame) clearFor(contents);
    });
    contents.once("destroyed", () => {
        clearFor(contents);
        activeGuests.delete(contents.id);
        watched.delete(contents.id);
    });
}
function capture(host: WebContents, guestId?: number): Target {
    if (!liveContextMenuHost(host)) return null;
    const guest = guestId != null ? webContents.fromId(guestId) : null;
    if (guestId != null && (!ownedMenuGuest(host, guest) || !activeGuests.get(host.id)?.has(guestId))) return null;
    const target = guest ?? host;
    watch(host);
    watch(target);
    const owner = contextMenuWindow(host);
    if (!watchedWindows.has(owner.id)) {
        watchedWindows.add(owner.id);
        owner.on("blur", () => {
            for (const contents of webContents.getAllWebContents()) {
                if (contextMenuWindow(contents)?.id === owner.id) clearFor(contents);
            }
        });
        owner.once("closed", () => watchedWindows.delete(owner.id));
    }
    return {
        host,
        target,
        url: target.getURL(),
        expires: Date.now() + 60000,
        revoked: false,
        generation: generations.get(target.id) ?? 0,
        hostGeneration: generations.get(host.id) ?? 0,
    };
}
export function contextMenuTargetLive(host: WebContents, token: string): boolean {
    return live(targets.get(token), host);
}
export function executeCapturedContextMenuRole(host: WebContents, token: string, requestedRole: string): boolean {
    const target = targets.get(token);
    const role = contextMenuRole(requestedRole);
    if (!role || !live(target, host)) return false;
    dropLease(targets, token, false);
    target.target.focus();
    target.target[role]();
    return true;
}
export function initMoltentermContextMenu(
    saveImage: (host: WebContents, guest: WebContents, source: string, valid: () => boolean) => Promise<void>
) {
    ipcMain.on("moltenterm-contextmenu-revoke", (event, token: string) => {
        for (const map of [targets, images]) {
            const target = map.get(token);
            if (target?.host !== event.sender) continue;
            dropLease(map, token);
            ContextMenuEvents.emit("revoke", event.sender, token);
        }
    });
    ipcMain.on("moltenterm-contextmenu-guest", (event, guestId: number, active: boolean) => {
        if (!liveContextMenuHost(event.sender, false) || !Number.isInteger(guestId)) return;
        const guest = webContents.fromId(guestId);
        if (!ownedMenuGuest(event.sender, guest)) return;
        const set = activeGuests.get(event.sender.id) ?? new Set<number>();
        activeGuests.set(event.sender.id, set);
        if (active === true) set.add(guestId);
        else {
            set.delete(guestId);
            clearFor(guest);
        }
        watch(event.sender);
        watch(guest);
    });
    ipcMain.on("moltenterm-contextmenu-capture", (event, guestId: number) => {
        const target = capture(event.sender, guestId);
        if (!target) {
            event.returnValue = null;
            return;
        }
        for (const [token, old] of targets) if (old.host === event.sender) dropLease(targets, token);
        const token = randomUUID();
        retainLease(targets, token, target);
        event.returnValue = token;
    });
    ipcMain.on("moltenterm-contextmenu-role", (event, token: string, requestedRole: string) => {
        executeCapturedContextMenuRole(event.sender, token, requestedRole);
    });
    ipcMain.on("moltenterm-contextmenu-guest-request", (event, payload) => {
        const guest = event.sender;
        const host = guest.hostWebContents;
        if (
            !host ||
            !liveContextMenuHost(host) ||
            !ownedMenuGuest(host, guest) ||
            !activeGuests.get(host.id)?.has(guest.id)
        )
            return;
        if (!payload || !Number.isFinite(payload.x) || !Number.isFinite(payload.y)) return;
        let imageToken: string;
        for (const [token, old] of images) if (old.host === host) dropLease(images, token);
        if (supportedMenuImage(payload.src)) {
            imageToken = randomUUID();
            retainLease(images, imageToken, { ...capture(host, guest.id), source: payload.src });
        }
        // Native cursor coordinates are DIP. The host view offset and host zoom, not display scale, convert them to CSS.
        const window = getWaveWindowByWebContentsId(host.id);
        const builder = getBuilderWindowByWebContentsId(host.id);
        const origin = (window ?? builder).getContentBounds();
        const view = window?.activeTabView?.getBounds() ?? { x: 0, y: 0 };
        const cursor = screen.getCursorScreenPoint();
        host.send("moltenterm-contextmenu-guest-show", {
            guestId: guest.id,
            guestX: payload.x,
            guestY: payload.y,
            guestScale: guest.getZoomFactor() / host.getZoomFactor(),
            x: (cursor.x - origin.x - view.x) / host.getZoomFactor(),
            y: (cursor.y - origin.y - view.y) / host.getZoomFactor(),
            linkURL: typeof payload.linkURL === "string" ? payload.linkURL : null,
            selectionText: typeof payload.selectionText === "string" ? payload.selectionText.slice(0, 4096) : null,
            editable: payload.editable === true,
            imageToken,
        } satisfies GuestContextMenu);
    });
    ipcMain.on("moltenterm-contextmenu-save-image", (event, token: string) => {
        const image = images.get(token);
        if (!live(image, event.sender)) return;
        dropLease(images, token, false);
        void saveImage(image.host, image.target, image.source, () => live(image, event.sender)).catch((error) =>
            console.error("context menu image save failed", error)
        );
    });
}
