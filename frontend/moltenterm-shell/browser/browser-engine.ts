// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The installed browser engine (FR-BRW-002, DS-BRW-002): wavesrv finds the user's Chromium browsers, routes a page
// (explicit engine, then the per-site choice, then browser:default) and asks the OS to open it there
// (pkg/molten/browsers). A page meant for a browser that is missing or fails to start comes back with the reason, and
// opens in the browser panel (the "app" engine).

import { getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom } from "jotai";

// must match pkg/molten/browsers/route.go
export const BrowserRouteId = "molten:browser";
export const BrowserListCommand = "moltenbrowserlist";
export const BrowserOpenCommand = "moltenbrowseropen";
export const BrowserActivateCommand = "moltenbrowseractivate";
export const BrowserSiteCommand = "moltenbrowsersite";

// must match EngineApp and EngineInstalled in pkg/molten/browsers/browsers.go
export const EngineApp = "app";
export const EngineInstalled = "installed";

const BrowserRpcTimeoutMs = 20000;

export type InstalledBrowser = { id: string; name: string; path: string };

export type BrowserRoute = { engine: string; browser?: InstalledBrowser; site?: string; fallback?: string };

export type BrowserList = {
    browsers: InstalledBrowser[];
    chosen?: InstalledBrowser;
    default: string;
    sites?: Record<string, string>;
    problem?: string;
};

// Font Awesome Free has brand marks for some browsers; the others get a generic one.
const BrandIcons: Record<string, string> = {
    brave: "fa-brands fa-brave",
    chrome: "fa-brands fa-chrome",
    edge: "fa-brands fa-edge",
    opera: "fa-brands fa-opera",
};

export function browserIconClass(engine: string): string {
    return BrandIcons[engine] ?? "fa-solid fa-compass";
}

const KnownNames: Record<string, string> = {
    brave: "Brave",
    chrome: "Chrome",
    edge: "Edge",
    arc: "Arc",
    vivaldi: "Vivaldi",
    opera: "Opera",
    chromium: "Chromium",
};

// The name of an engine for a tab or a menu: the detected browser's, else the known one, else the id.
export function engineName(engine: string, list?: BrowserList): string {
    if (!engine || engine === EngineApp) {
        return "MoltenTerm";
    }
    if (engine === EngineInstalled || engine === list?.chosen?.id) {
        return list?.chosen?.name ?? KnownNames[engine] ?? "your browser";
    }
    return list?.browsers?.find((b) => b.id === engine)?.name ?? KnownNames[engine] ?? engine;
}

// The site a per-site choice is recorded for: the page's host, without "www.".
export function siteOf(url: string): string {
    try {
        const u = new URL(url);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
            return null;
        }
        return u.hostname.toLowerCase().replace(/^www\./, "") || null;
    } catch {
        return null;
    }
}

// The per-site entry that applies to url: its host, else its closest parent domain. Must match SiteEngine in
// pkg/molten/browsers/browsers.go.
export function siteEngine(sites: Record<string, string>, url: string): { engine: string; site: string } {
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return { engine: "", site: "" };
    }
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(sites ?? {})) {
        lower[k.trim().toLowerCase()] = v;
    }
    while (host) {
        const v = lower[host];
        if (typeof v === "string" && v.trim() !== "") {
            return { engine: v.trim().toLowerCase(), site: host };
        }
        const dot = host.indexOf(".");
        if (dot < 0) {
            break;
        }
        host = host.slice(dot + 1);
    }
    return { engine: "", site: "" };
}

// The engine the settings give a page without an explicit one: the per-site choice, else browser:default, else the
// app. Must match Resolve in pkg/molten/browsers/browsers.go, so wavesrv is asked only when the answer is an installed
// browser and a page that stays here (a site remembered as "app" included) opens without a round trip.
export function localEngine(defaultEngine: string, sites: Record<string, string>, url: string): string {
    const site = siteEngine(sites, url).engine;
    if (site !== "") {
        return site;
    }
    return (defaultEngine ?? "").trim().toLowerCase() || EngineApp;
}

export function fallbackReason(route: BrowserRoute): string {
    if (!route?.fallback) {
        return null;
    }
    return route.fallback.charAt(0).toUpperCase() + route.fallback.slice(1) + ".";
}

export function fallbackNotice(route: BrowserRoute): string {
    const reason = fallbackReason(route);
    return reason ? `${reason} Opened in MoltenTerm instead.` : null;
}

function browserCall<T>(command: string, data: any): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: BrowserRouteId, timeout: BrowserRpcTimeoutMs });
}

export function browserOpen(url: string, engine?: string): Promise<BrowserRoute> {
    return browserCall(BrowserOpenCommand, { url, engine: engine || undefined });
}

export function browserActivate(engine: string, url: string): Promise<BrowserRoute> {
    return browserCall(BrowserActivateCommand, { url, engine });
}

export function browserSetSite(site: string, engine: string): Promise<Record<string, string>> {
    return browserCall(BrowserSiteCommand, { site, engine: engine || undefined });
}

// The detected browsers, loaded once per window and again when the browser settings change.
export class BrowserEngineModel {
    private static instance: BrowserEngineModel = null;

    listAtom = atom(null) as PrimitiveAtom<BrowserList>;
    loadedKey: string = null;
    loading: Promise<void> = null;

    private constructor() {}

    static getInstance(): BrowserEngineModel {
        if (BrowserEngineModel.instance == null) {
            BrowserEngineModel.instance = new BrowserEngineModel();
        }
        return BrowserEngineModel.instance;
    }

    settingsKey(): string {
        return JSON.stringify([
            globalStore.get(getSettingsKeyAtom("browser:installed")) ?? "",
            globalStore.get(getSettingsKeyAtom("browser:default")) ?? "",
            globalStore.get(getSettingsKeyAtom("browser:sites")) ?? {},
        ]);
    }

    ensureLoaded(): Promise<void> {
        const key = this.settingsKey();
        if (key === this.loadedKey && this.loading != null) {
            return this.loading;
        }
        this.loadedKey = key;
        this.loading = browserCall<BrowserList>(BrowserListCommand, null)
            .then((list) => globalStore.set(this.listAtom, list))
            .catch((e) => {
                console.log("molten browser: cannot list the installed browsers", e);
                this.loadedKey = null;
            });
        return this.loading;
    }

    // The installed browser pages are handed off to, or null when there is none.
    chosen(): InstalledBrowser {
        return globalStore.get(this.listAtom)?.chosen ?? null;
    }

    // Whether wavesrv must route this page: the settings send it to an installed browser.
    needsRouting(url: string): boolean {
        if (siteOf(url) == null) {
            return false;
        }
        const def = globalStore.get(getSettingsKeyAtom("browser:default"));
        const sites = globalStore.get(getSettingsKeyAtom("browser:sites"));
        return localEngine(def, sites, url) !== EngineApp;
    }
}
