// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The browser panel's side of hidden pages frozen and discarded (#459, FR-PERF-013, emain/moltenterm-webview-lifecycle.ts):
// each tab's webview reports whether it is shown (its tab is the panel's active one and the tab view shows, per the
// tab activity model); the main process freezes a hidden page and, after the discard delay, asks the panel to drop it.
// A discarded tab keeps its URL, title and favicon; shown again, it gets a new webview at its URL behind a light
// placeholder, and its scroll position back once the page has loaded.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";

export type PageScroll = { x: number; y: number };

type DiscardHandler = (browserTabId: string, webContentsId: number, scroll: PageScroll) => void;

type LifecycleElectronApi = {
    moltentermWebviewShown?: (blockId: string, browserTabId: string, webContentsId: number, shown: boolean) => void;
    onMoltentermWebviewDiscard?: (
        callback: (blockId: string, browserTabId: string, webContentsId: number, scroll: PageScroll) => void
    ) => () => void;
};

function lifecycleApi(): LifecycleElectronApi {
    return ((globalThis as any).api ?? {}) as LifecycleElectronApi;
}

const panels = new Map<string, DiscardHandler>();
let listening = false;

function listen() {
    if (listening) {
        return;
    }
    listening = true;
    lifecycleApi().onMoltentermWebviewDiscard?.((blockId, browserTabId, webContentsId, scroll) => {
        panels.get(blockId)?.(browserTabId, webContentsId, scroll);
    });
}

export function reportWebviewShown(blockId: string, browserTabId: string, webContentsId: number, shown: boolean) {
    if (webContentsId == null) {
        return;
    }
    lifecycleApi().moltentermWebviewShown?.(blockId, browserTabId, webContentsId, shown);
}

// The scroll position to give back, clamped to sane values (it comes from the page).
export function scrollScript(scroll: PageScroll): string {
    const x = Math.max(0, Math.round(Number(scroll?.x) || 0));
    const y = Math.max(0, Math.round(Number(scroll?.y) || 0));
    return `window.scrollTo(${x}, ${y})`;
}

// Whether a discarded tab gets its webview back now: shown in the panel on screen, or driven by an agent.
export function shouldRestore(isActiveTab: boolean, viewShown: boolean, agentDriven: boolean): boolean {
    return agentDriven || (isActiveTab && viewShown);
}

export class BrowserLifecycleModel {
    blockId: string;
    // Tabs whose webview was dropped, with the scroll position to restore.
    discardedAtom = atom({}) as PrimitiveAtom<Record<string, PageScroll>>;
    // Tabs reloading after a discard, until their page has loaded.
    restoringAtom = atom({}) as PrimitiveAtom<Record<string, PageScroll>>;

    constructor(blockId: string) {
        this.blockId = blockId;
    }

    start(handler: DiscardHandler) {
        listen();
        panels.set(this.blockId, handler);
    }

    dispose() {
        panels.delete(this.blockId);
    }

    isDiscarded(tabId: string): boolean {
        return globalStore.get(this.discardedAtom)[tabId] != null;
    }

    discard(tabId: string, scroll: PageScroll) {
        const cur = globalStore.get(this.discardedAtom);
        globalStore.set(this.discardedAtom, { ...cur, [tabId]: scroll ?? { x: 0, y: 0 } });
    }

    restore(tabId: string) {
        const cur = globalStore.get(this.discardedAtom);
        const scroll = cur[tabId];
        if (scroll == null) {
            return;
        }
        const { [tabId]: _, ...rest } = cur;
        globalStore.set(this.restoringAtom, { ...globalStore.get(this.restoringAtom), [tabId]: scroll });
        globalStore.set(this.discardedAtom, rest);
    }

    // The page loaded (or failed): returns the scroll position to put back, once.
    finishRestoring(tabId: string): PageScroll {
        const cur = globalStore.get(this.restoringAtom);
        const scroll = cur[tabId];
        if (scroll == null) {
            return null;
        }
        const { [tabId]: _, ...rest } = cur;
        globalStore.set(this.restoringAtom, rest);
        return scroll;
    }

    forget(tabId: string) {
        for (const a of [this.discardedAtom, this.restoringAtom]) {
            const cur = globalStore.get(a);
            if (cur[tabId] != null) {
                const { [tabId]: _, ...rest } = cur;
                globalStore.set(a, rest);
            }
        }
    }
}
