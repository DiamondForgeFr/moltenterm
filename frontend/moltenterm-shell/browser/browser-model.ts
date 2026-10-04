// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The tabs of a browser panel (FR-SHELL-007), kept in the block meta so they come back after a restart. Pure
// functions: the view applies them and writes the result.

// must match BrowserView, BrowserTabsMetaKey and BrowserActiveMetaKey in pkg/molten/browser.go
export const MoltentermBrowserView = "molten-browser";
export const BrowserTabsMetaKey = "molten:browser:tabs";
export const BrowserActiveMetaKey = "molten:browser:active";

export type BrowserTab = { id: string; url: string; title?: string };

export type BrowserState = { tabs: BrowserTab[]; activeId: string };

let tabCounter = 0;

export function makeTabId(): string {
    tabCounter += 1;
    return `${Date.now().toString(36)}-${tabCounter}`;
}

export function readBrowserState(meta: Record<string, any>, defaultUrl: string, newId = makeTabId): BrowserState {
    const raw = meta?.[BrowserTabsMetaKey];
    const tabs: BrowserTab[] = Array.isArray(raw)
        ? raw
              .filter((t) => t != null && typeof t.id === "string" && typeof t.url === "string")
              .map((t) => ({ id: t.id, url: t.url, title: typeof t.title === "string" ? t.title : undefined }))
        : [];
    if (tabs.length === 0) {
        // A browser panel always has one tab: the block's own URL, or the default page.
        tabs.push({ id: newId(), url: meta?.url || defaultUrl });
    }
    const active = meta?.[BrowserActiveMetaKey];
    return { tabs, activeId: tabs.some((t) => t.id === active) ? active : tabs[0].id };
}

// Every web page Moltenterm opens gets a browser panel, never Wave's web view without tabs (#132). The panel opens
// meta "url" as its single tab.
export function browserBlockDef(url: string): BlockDef {
    return { meta: { view: MoltentermBrowserView, url } };
}

export function browserMeta(state: BrowserState): Record<string, any> {
    return {
        [BrowserTabsMetaKey]: state.tabs.map((t) =>
            t.title ? { id: t.id, url: t.url, title: t.title } : { id: t.id, url: t.url }
        ),
        [BrowserActiveMetaKey]: state.activeId,
    };
}

// A new tab opens right after the active one, as in a browser, and becomes active.
export function addTab(state: BrowserState, url: string, newId = makeTabId): BrowserState {
    const tab = { id: newId(), url };
    const index = state.tabs.findIndex((t) => t.id === state.activeId);
    const tabs = [...state.tabs];
    tabs.splice(index + 1, 0, tab);
    return { tabs, activeId: tab.id };
}

// Closing the active tab activates its right neighbour, or the left one at the end. The last tab cannot close: the
// caller closes the panel instead.
export function closeTab(state: BrowserState, id: string): BrowserState {
    if (state.tabs.length <= 1) {
        return state;
    }
    const index = state.tabs.findIndex((t) => t.id === id);
    if (index < 0) {
        return state;
    }
    const tabs = state.tabs.filter((t) => t.id !== id);
    if (state.activeId !== id) {
        return { tabs, activeId: state.activeId };
    }
    return { tabs, activeId: tabs[Math.min(index, tabs.length - 1)].id };
}

export function activateTab(state: BrowserState, id: string): BrowserState {
    return state.tabs.some((t) => t.id === id) ? { ...state, activeId: id } : state;
}

export function moveTab(state: BrowserState, id: string, toIndex: number): BrowserState {
    const from = state.tabs.findIndex((t) => t.id === id);
    if (from < 0) {
        return state;
    }
    const tabs = [...state.tabs];
    const [tab] = tabs.splice(from, 1);
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab);
    return { ...state, tabs };
}

export function updateTab(state: BrowserState, id: string, patch: Partial<Omit<BrowserTab, "id">>): BrowserState {
    let changed = false;
    const tabs = state.tabs.map((t) => {
        if (t.id !== id) {
            return t;
        }
        const next = { ...t, ...patch };
        changed = next.url !== t.url || next.title !== t.title;
        return next;
    });
    return changed ? { ...state, tabs } : state;
}

// What the user types in the address bar: a URL, a host, or words to search.
export function toBrowserUrl(input: string, searchTemplate = "https://duckduckgo.com/?q=%s"): string {
    const text = input.trim();
    if (text === "") {
        return null;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|file|data):/i.test(text)) {
        return text;
    }
    if (
        !/\s/.test(text) &&
        (/^localhost(:\d+)?(\/|$)/i.test(text) || /^[^/\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text))
    ) {
        return (/^localhost/i.test(text) ? "http://" : "https://") + text;
    }
    return searchTemplate.replace("%s", encodeURIComponent(text));
}

// A tab names its page: its title, or its host while the title is unknown.
export function browserTabTitle(tab: BrowserTab): string {
    const title = tab?.title?.trim();
    if (title) {
        return title;
    }
    try {
        return new URL(tab?.url).hostname;
    } catch {
        return "";
    }
}
