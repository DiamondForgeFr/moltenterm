// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The load state of the browser panel's tabs (#210): whether each tab's page is loading and its favicon, fed by the
// tab's <webview> events. In memory only: neither is worth restoring after a restart.

import { globalStore } from "@/app/store/jotaiStore";
import { getWebServerEndpoint } from "@/util/endpoints";
import { atom, PrimitiveAtom } from "jotai";
import { originOfAddress } from "../favicon/site";

// crashed: the page's process is gone (#1814), so the 360 carpet takes no thumbnail of it until it loads again.
// favicon: the icon the page declared, never drawn as it is when it is a web address (tabFaviconSrc); site: the origin
// of the page that declared it, under which Electron main keeps the icon it read.
export type TabLoad = { loading?: boolean; favicon?: string; site?: string; crashed?: boolean };

const InlineImage = /^data:image\//i;

export const ReloadStop = "stop";
export const ReloadNormal = "reload";
export const ReloadIgnoringCache = "reload-ignoring-cache";

// What the Reload button (or Cmd+R) does: a loading page stops; otherwise it reloads, ignoring the cache when asked
// (Shift+click, Cmd+Shift+R).
export function reloadAction(loading: boolean, ignoreCache: boolean): string {
    if (loading) {
        return ReloadStop;
    }
    return ignoreCache ? ReloadIgnoringCache : ReloadNormal;
}

export type ReloadTarget = { stop(): void; reload(): void; reloadIgnoringCache(): void };

// A <webview> throws when called before its first dom-ready; such a page is still loading its first document, so
// there is nothing to reload yet.
export function runReload(webview: ReloadTarget, action: string): boolean {
    if (webview == null) {
        return false;
    }
    try {
        if (action === ReloadStop) {
            webview.stop();
        } else if (action === ReloadIgnoringCache) {
            webview.reloadIgnoringCache();
        } else {
            webview.reload();
        }
        return true;
    } catch (e) {
        console.log("browser reload failed", e);
        return false;
    }
}

function sameOrigin(url: string, other: string): boolean {
    try {
        return new URL(url).origin === new URL(other).origin;
    } catch {
        return false;
    }
}

function backendEndpoint(): string {
    try {
        return getWebServerEndpoint();
    } catch {
        return null;
    }
}

// The favicon to show: the first http(s) or data icon the page declares. The tab strip draws it in MoltenTerm's own
// renderer, whose requests to the backend carry the app's credentials (#1961): an icon a page points at the backend is
// a request forged on the app's behalf, never loaded.
export function pickFavicon(favicons: string[], backend: string = backendEndpoint()): string {
    return (favicons ?? []).find(
        (u) => /^(https?:|data:image\/)/i.test(u ?? "") && (backend == null || !sameOrigin(u, backend))
    );
}

// What a tab strip may draw for a tab (#2045, FR-BRW-014): the app page loads no image from a web address (its
// Content-Security-Policy, emain/moltenterm-app-csp.ts), so a declared web icon is drawn from the copy Electron main
// kept for the page's site (a data: URL, favicon-store.ts), and an inline icon as it is. null: the generic web icon,
// until main has kept one.
export function tabFaviconSrc(load: TabLoad, icons: Record<string, { url: string }>): string {
    const declared = load?.favicon;
    if (declared == null) {
        return null;
    }
    if (InlineImage.test(declared)) {
        return declared;
    }
    const kept = load.site ? icons?.[load.site]?.url : null;
    return typeof kept === "string" && InlineImage.test(kept) ? kept : null;
}

export class BrowserLoadModel {
    loadsAtom = atom({}) as PrimitiveAtom<Record<string, TabLoad>>;

    get(tabId: string): TabLoad {
        return globalStore.get(this.loadsAtom)[tabId];
    }

    isLoading(tabId: string): boolean {
        return !!this.get(tabId)?.loading;
    }

    update(tabId: string, patch: TabLoad): void {
        const all = globalStore.get(this.loadsAtom);
        const current = all[tabId] ?? {};
        if (Object.keys(patch).every((k) => current[k as keyof TabLoad] === patch[k as keyof TabLoad])) {
            return;
        }
        globalStore.set(this.loadsAtom, { ...all, [tabId]: { ...current, ...patch } });
    }

    isCrashed(tabId: string): boolean {
        return !!this.get(tabId)?.crashed;
    }

    noteCrash(tabId: string): void {
        this.update(tabId, { crashed: true, loading: false });
    }

    noteStart(tabId: string): void {
        this.update(tabId, this.isCrashed(tabId) ? { loading: true, crashed: false } : { loading: true });
    }

    noteStop(tabId: string): void {
        this.update(tabId, { loading: false });
    }

    // Returns the site whose kept icon the tab now draws, for the caller to ask Electron main for it.
    noteFavicons(tabId: string, favicons: string[], pageUrl?: string): string {
        const favicon = pickFavicon(favicons);
        if (favicon == null) {
            return null;
        }
        const site = originOfAddress(pageUrl) || undefined;
        this.update(tabId, { favicon, site });
        return site ?? null;
    }

    forget(tabId: string): void {
        const all = globalStore.get(this.loadsAtom);
        if (!(tabId in all)) {
            return;
        }
        const next = { ...all };
        delete next[tabId];
        globalStore.set(this.loadsAtom, next);
    }
}
