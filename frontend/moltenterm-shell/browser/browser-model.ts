// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The tabs of a browser panel (FR-SHELL-007), kept in the block meta so they come back after a restart. Pure
// functions: the view applies them and writes the result.

// must match BrowserView, BrowserTabsMetaKey, BrowserActiveMetaKey, BrowserOpenKeyPrefix and BrowserRecentMetaKey in
// pkg/molten/browser.go
export const MoltentermBrowserView = "molten-browser";
export const BrowserTabsMetaKey = "molten:browser:tabs";
export const BrowserActiveMetaKey = "molten:browser:active";
// Block meta: the queue of pages wsh asks this panel to open as new tabs (#140), one key per page,
// "molten:browser:open:<id>" = url. One key each, so concurrent wsh writes merge instead of overwriting a shared list;
// ids are time-ordered (UUID v7), which gives the queue order.
export const BrowserOpenKeyPrefix = "molten:browser:open:";
// Tab meta: the browser panels of the tab, most recently focused first (#140).
export const BrowserRecentMetaKey = "molten:browser:recent";
const BrowserRecentMax = 8;

// Block meta: why a page meant for the installed browser opened here instead (FR-BRW-002), shown once by the panel.
export const BrowserNoticeMetaKey = "molten:browser:notice";
// Block meta: the panel was created for an interface link whose site has no engine yet (FR-BRW-006); its first tab
// shows the engine choice, taken once.
export const BrowserAskMetaKey = "molten:browser:ask";
// Block meta, with BrowserAskMetaKey: the panel was created for a page a terminal program opened through BROWSER
// (FR-BRW-007); the choice shows without taking the focus from the terminal. Must match BrowserKeepFocusMetaKey in
// pkg/molten/browser.go.
export const BrowserKeepFocusMetaKey = "molten:browser:keepfocus";

// engine: a handed-off entry, a page wsh already opened in that installed browser (FR-BRW-002). ask and keepFocus: a
// page a terminal program opened through BROWSER (FR-BRW-007, BrowserEnvRequestMeta in pkg/molten/browser.go) asks
// which engine its site uses when nothing is decided yet, and leaves the focus in the terminal.
export type BrowserOpenRequest = { id: string; url: string; engine?: string; ask?: boolean; keepFocus?: boolean };

// engine is unset for the in-app engine, else the id of the installed browser the page was handed off to (FR-BRW-002):
// the tab is then an entry with no page of its own here.
export type BrowserTab = { id: string; url: string; title?: string; engine?: string };

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
              .map((t) => {
                  const tab: BrowserTab = {
                      id: t.id,
                      url: t.url,
                      title: typeof t.title === "string" ? t.title : undefined,
                  };
                  if (typeof t.engine === "string" && t.engine !== "" && t.engine !== "app") {
                      tab.engine = t.engine;
                  }
                  return tab;
              })
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
export function browserBlockDef(url: string, notice?: string, askEngine?: boolean): BlockDef {
    const meta: Record<string, any> = { view: MoltentermBrowserView, url };
    if (notice) {
        meta[BrowserNoticeMetaKey] = notice;
    }
    if (askEngine) {
        meta[BrowserAskMetaKey] = true;
    }
    return { meta: meta as MetaType };
}

// Where a link opened inside Moltenterm goes (#140): the most recently focused browser panel of the tab that still
// exists, else the last browser panel of the tab (one not focused since a restart), else none (a new panel).
// Must match PickBrowserPanel in pkg/molten/browser.go.
export function pickBrowserPanel(browserBlockIds: string[], recent: unknown): string {
    const ids = browserBlockIds ?? [];
    for (const id of readRecentBrowserPanels(recent)) {
        if (ids.includes(id)) {
            return id;
        }
    }
    return ids.length > 0 ? ids[ids.length - 1] : null;
}

export function readRecentBrowserPanels(recent: unknown): string[] {
    return Array.isArray(recent) ? recent.filter((id): id is string => typeof id === "string" && id !== "") : [];
}

// The focus history with blockId moved to the front, or null when it is already there (nothing to write).
export function noteBrowserFocus(recent: unknown, blockId: string): string[] {
    const ids = readRecentBrowserPanels(recent);
    if (!blockId || ids[0] === blockId) {
        return null;
    }
    return [blockId, ...ids.filter((id) => id !== blockId)].slice(0, BrowserRecentMax);
}

// The pages queued in a panel's block meta, in queue order.
export function readOpenRequests(meta: Record<string, any>): BrowserOpenRequest[] {
    const rtn: BrowserOpenRequest[] = [];
    for (const [key, value] of Object.entries(meta ?? {})) {
        const id = key.startsWith(BrowserOpenKeyPrefix) ? key.slice(BrowserOpenKeyPrefix.length) : "";
        if (id === "") {
            continue;
        }
        if (typeof value === "string" && value !== "") {
            rtn.push({ id, url: value });
            continue;
        }
        // A handed-off entry or a page from BROWSER (BrowserHandoffRequestMeta, BrowserEnvRequestMeta in
        // pkg/molten/browser.go).
        if (value != null && typeof value.url === "string" && value.url !== "") {
            const request: BrowserOpenRequest = { id, url: value.url };
            if (typeof value.engine === "string" && value.engine !== "" && value.engine !== "app") {
                request.engine = value.engine;
            }
            if (value.ask === true) {
                request.ask = true;
            }
            if (value.keepfocus === true) {
                request.keepFocus = true;
            }
            rtn.push(request);
        }
    }
    return rtn.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// The meta update that takes the opened pages out of the queue, and only them: a page wsh queues meanwhile is a key of
// its own and stays.
export function consumeOpenRequestsMeta(consumed: BrowserOpenRequest[]): Record<string, null> {
    const rtn: Record<string, null> = {};
    for (const request of consumed) {
        rtn[BrowserOpenKeyPrefix + request.id] = null;
    }
    return rtn;
}

export function browserMeta(state: BrowserState): Record<string, any> {
    return {
        [BrowserTabsMetaKey]: state.tabs.map((t) => {
            const saved: Record<string, string> = { id: t.id, url: t.url };
            if (t.title) {
                saved.title = t.title;
            }
            if (t.engine) {
                saved.engine = t.engine;
            }
            return saved;
        }),
        [BrowserActiveMetaKey]: state.activeId,
    };
}

export type AddTabOpts = { engine?: string; activate?: boolean };

// A new tab opens right after the active one, as in a browser, and becomes active unless opts.activate is false.
export function addTab(state: BrowserState, url: string, newId = makeTabId, opts?: AddTabOpts): BrowserState {
    const tab: BrowserTab = opts?.engine ? { id: newId(), url, engine: opts.engine } : { id: newId(), url };
    const index = state.tabs.findIndex((t) => t.id === state.activeId);
    const tabs = [...state.tabs];
    tabs.splice(index + 1, 0, tab);
    return { tabs, activeId: opts?.activate === false ? state.activeId : tab.id };
}

// Moves a tab to another engine (FR-BRW-002): a browser id makes it a handed-off entry, "app" or "" brings the page
// back into the panel.
export function setTabEngine(state: BrowserState, id: string, engine: string): BrowserState {
    const next = engine && engine !== "app" ? engine : undefined;
    let changed = false;
    const tabs = state.tabs.map((t) => {
        if (t.id !== id || t.engine === next) {
            return t;
        }
        changed = true;
        const { engine: _old, ...rest } = t;
        return next ? { ...rest, engine: next } : rest;
    });
    return changed ? { ...state, tabs } : state;
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
