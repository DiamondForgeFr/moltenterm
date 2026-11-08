// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a <webview> may attach with (#1961, FR-BRW-014). The tag's attributes come from the app renderer, so a renderer
// bug (an injected `nodeintegration`, `webpreferences="contextIsolation=no"` or a `preload` pointing elsewhere) would
// hand a web page Node or an unreviewed preload. Main fixes the guest's preferences whatever the tag asked for: no Node,
// isolated and sandboxed, web security on, no nested webviews, and only MoltenTerm's own page preload.

import path from "node:path";
import { fileURLToPath } from "node:url";

// Schemes a guest never starts on: script URLs and the engine's own pages.
const RefusedSrcSchemes = ["javascript:", "vbscript:", "chrome:", "devtools:", "chrome-devtools:", "view-source:"];

type Preferences = Record<string, unknown>;

// The one preload a guest may run (emain/preload-webview.ts, built by electron.vite.config.ts).
export function webviewPreloadFile(appBasePath: string): string {
    return path.join(appBasePath, "preload", "preload-webview.cjs");
}

function samePath(a: string, b: string): boolean {
    return path.resolve(a) === path.resolve(b);
}

function preloadPath(value: unknown): string {
    if (typeof value !== "string" || value === "") {
        return null;
    }
    if (!value.startsWith("file:")) {
        return value;
    }
    try {
        return fileURLToPath(value);
    } catch {
        return null;
    }
}

export function refusedWebviewSrc(src: unknown): boolean {
    if (typeof src !== "string") {
        return false;
    }
    const scheme = /^\s*([a-z][a-z0-9+.-]*:)/i.exec(src)?.[1]?.toLowerCase();
    return scheme != null && RefusedSrcSchemes.includes(scheme);
}

// Rewrites preferences in place; returns false when the webview must not attach at all.
export function hardenWebviewAttach(
    preferences: Preferences,
    params: Record<string, unknown>,
    pagePreload: string
): boolean {
    if (refusedWebviewSrc(params?.src)) {
        return false;
    }
    preferences.nodeIntegration = false;
    preferences.nodeIntegrationInSubFrames = false;
    preferences.nodeIntegrationInWorker = false;
    preferences.contextIsolation = true;
    preferences.sandbox = true;
    preferences.webSecurity = true;
    preferences.allowRunningInsecureContent = false;
    preferences.experimentalFeatures = false;
    preferences.webviewTag = false;
    delete preferences.enableBlinkFeatures;
    delete preferences.preloadURL;
    const preload = preloadPath(preferences.preload);
    if (preload == null || pagePreload == null || !samePath(preload, pagePreload)) {
        delete preferences.preload;
    }
    return true;
}
