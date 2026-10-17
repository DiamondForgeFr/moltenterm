// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// MOLTENTERM-PATCH (#805): private app sessions and registered-frame caller credentials.

import { configurePrivilegedIpc, onAppIpc } from "./moltenterm-privileged-ipc"; // MOLTENTERM-PATCH (#806)
import { session, webContents } from "electron";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getWebServerEndpoint, getWSServerEndpoint } from "../frontend/util/endpoints";
import { configureNativeFetchPolicy } from "../frontend/util/fetchutil";
import { getElectronAppBasePath, isDevVite } from "./emain-platform";
import {
    AppSessionPartition,
    CallerHeader,
    callerProof,
    CallerProofHeader,
    isBackendDestination,
    permitsCredentialResource,
    stripBackendCredentials,
    TrustedAppCallers,
} from "./moltenterm-app-auth-policy";

const AuthKeyHeader = "X-AuthKey";
export const WaveAuthKeyEnv = "WAVETERM_AUTH_KEY";
export const AuthKey = crypto.randomUUID();
export const CallerSecret = randomBytes(32).toString("hex");
export const AppOrigin = isDevVite ? new URL(process.env.ELECTRON_RENDERER_URL).origin : "";
const trustedAppCallers = new TrustedAppCallers();
configurePrivilegedIpc(isTrustedAppSender);
const configuredSessions = new WeakSet<Electron.Session>();
const rendererProof = callerProof(CallerSecret, "renderer");
const mainProof = callerProof(CallerSecret, "main");

export function nativeBackendHeaders(): Record<string, string> {
    return { [AuthKeyHeader]: AuthKey, [CallerHeader]: "main", [CallerProofHeader]: mainProof };
}

configureNativeFetchPolicy((url, init) => {
    const headers = new Headers(init.headers);
    for (const name of [AuthKeyHeader, CallerHeader, CallerProofHeader]) headers.delete(name);
    if (!isBackendDestination(url, [getWebServerEndpoint()])) return { ...init, headers };
    for (const [name, value] of Object.entries(nativeBackendHeaders())) headers.set(name, value);
    // Never forward a privileged request to a redirect target, including another local service.
    return { ...init, headers, redirect: "error" };
});

export function getAppDocumentUrl(): string {
    return isDevVite
        ? `${process.env.ELECTRON_RENDERER_URL}/index.html`
        : pathToFileURL(path.join(getElectronAppBasePath(), "frontend", "index.html")).href;
}

export function getTrustedAppSession(): Electron.Session {
    const appSession = session.fromPartition(AppSessionPartition);
    configureAuthKeyRequestInjection(appSession);
    return appSession;
}

export function isTrustedAppSender(event: Pick<Electron.IpcMainEvent, "sender" | "senderFrame">): boolean {
    return trustedAppCallers.allows(event.sender, event.senderFrame);
}

export function registerTrustedAppContents(contents: Electron.WebContents): void {
    const appSession = getTrustedAppSession();
    if (contents.session !== appSession) throw new Error("Application contents must use the private app session");
    trustedAppCallers.register(contents, appSession, getAppDocumentUrl());
    contents.once("destroyed", () => trustedAppCallers.forget(contents));
    contents.on("will-attach-webview", (event, preferences, params) => {
        const partition = params.partition || "";
        if (partition === AppSessionPartition || partition === `persist:${AppSessionPartition}`) {
            event.preventDefault();
            return;
        }
        // Default guests retain the existing default persistent browsing session; custom partitions stay intact.
        delete preferences.session;
        preferences.partition = partition;
    });
}

onAppIpc("get-auth-key", (event) => {
    event.returnValue = AuthKey;
});

export function configureAuthKeyRequestInjection(session: Electron.Session) {
    if (configuredSessions.has(session)) return;
    configuredSessions.add(session);
    const filter: Electron.WebRequestFilter = {
        // Strip credentials on redirected/external requests too; only exact backend origins can receive them.
        urls: ["<all_urls>"],
    };
    session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
        const headers = stripBackendCredentials(details.requestHeaders);
        const contents = webContents.fromId(details.webContentsId);
        if (
            isBackendDestination(details.url, [getWebServerEndpoint(), getWSServerEndpoint()]) &&
            permitsCredentialResource(details.resourceType) &&
            trustedAppCallers.allows(contents, details.frame)
        ) {
            headers[AuthKeyHeader] = AuthKey;
            headers[CallerHeader] = "renderer";
            headers[CallerProofHeader] = rendererProof;
        }
        callback({ requestHeaders: headers });
    });
}
