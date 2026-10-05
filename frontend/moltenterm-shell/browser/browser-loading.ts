// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The load state of the browser panel's tabs (#210): whether each tab's page is loading and its favicon, fed by the
// tab's <webview> events. In memory only: neither is worth restoring after a restart.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";

export type TabLoad = { loading?: boolean; favicon?: string };

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

// The favicon to show: the first http(s) or data icon the page declares.
export function pickFavicon(favicons: string[]): string {
    return (favicons ?? []).find((u) => /^(https?:|data:image\/)/i.test(u ?? ""));
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

    noteStart(tabId: string): void {
        this.update(tabId, { loading: true });
    }

    noteStop(tabId: string): void {
        this.update(tabId, { loading: false });
    }

    noteFavicons(tabId: string, favicons: string[]): void {
        const favicon = pickFavicon(favicons);
        if (favicon == null) {
            return;
        }
        this.update(tabId, { favicon });
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
