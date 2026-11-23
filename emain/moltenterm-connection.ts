// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The connection state of the pages of the browser panel in Electron main (#1980, FR-BRW-023, DS-BRW-028). Main reads the
// address each webview guest committed, Chromium's console report of insecure content and the certificate Chromium
// verified, and tells the window holding the guest; the window pulls the current state when it registers a webview.
//
// The certificate observer is read-only: it records the certificate of a host and always answers with Chromium's own
// verdict (-3), so no certificate error is ever bypassed and Certificate Transparency stays on. The records stay in
// memory. The web page preload exposes nothing to the page: the page cannot see or improve what is said here.

import * as electron from "electron";
import { summarizeCertificate } from "../frontend/moltenterm-shell/browser/connection-security";
import { CertificateMemory, ConnectionRegistry } from "./moltenterm-connection-registry";
import { handleAppIpc } from "./moltenterm-privileged-ipc";
import { liveWebContentsFromId } from "./moltenterm-webcontents-id";

// main -> the renderer holding the webview: (guestWebContentsId, ConnectionState)
export const ConnectionStateChannel = "moltenterm-connection-state";
// renderer -> main, invoked with the guest's web contents id: its ConnectionState, or null
export const ConnectionGetChannel = "moltenterm-connection-get";

// Electron's verification result for "use the verdict Chromium reached".
const UseChromiumVerdict = -3;

const certificates = new CertificateMemory();
const hookedSessions = new WeakSet<electron.Session>();
const registry = new ConnectionRegistry(certificates, (webContentsId, state) => {
    const guest = liveWebContentsFromId(webContentsId);
    const host = guest?.hostWebContents;
    if (host != null && !host.isDestroyed()) {
        host.send(ConnectionStateChannel, webContentsId, state);
    }
});

function hookSession(session: electron.Session): void {
    if (session == null || hookedSessions.has(session)) {
        return;
    }
    hookedSessions.add(session);
    session.setCertificateVerifyProc((request, callback) => {
        try {
            if (request.verificationResult === "net::OK") {
                certificates.note(request.hostname, summarizeCertificate(request.certificate));
            }
        } catch (e) {
            console.log("connection: certificate not noted", e instanceof Error ? e.message : String(e));
        }
        callback(UseChromiumVerdict);
    });
}

// Called for each webview a tab view attaches.
export function observeConnectionGuest(guest: electron.WebContents): void {
    const id = guest.id;
    guest.on("did-navigate", (_event, url) => registry.committed(id, url, false));
    guest.on("did-navigate-in-page", (_event, url, isMainFrame) => {
        if (isMainFrame) {
            registry.committed(id, url, true);
        }
    });
    guest.on("console-message", (event) => registry.consoleMessage(id, event?.message));
    guest.once("destroyed", () => registry.forget(id));
}

// Before any window: every session, the default one and each partition created later.
export function installMoltentermConnection(): void {
    hookSession(electron.session.defaultSession);
    electron.app.on("session-created", (session) => hookSession(session));
    handleAppIpc(ConnectionGetChannel, (event, webContentsId: unknown) => {
        const guest = liveWebContentsFromId(webContentsId);
        if (guest == null || guest.getType() !== "webview" || guest.hostWebContents?.id !== event.sender.id) {
            return null;
        }
        return registry.stateOf(guest.id);
    });
}
