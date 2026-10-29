// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The tabs of a browser panel (FR-SHELL-007), kept in the block meta so they come back after a restart. Pure
// functions: the view applies them and writes the result. Since #1187 (FR-SHELL-083) a panel shows one page: what
// opened a tab opens a panel beside it, and the list holds that one page.

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

// Block meta: the queue of tabs to close (FR-BRW-008, an agent's tabs_close), "molten:browser:close:<id>" = tab id.
// Must match BrowserCloseKeyPrefix in pkg/molten/browser.go.
export const BrowserCloseKeyPrefix = "molten:browser:close:";

// engine: a handed-off entry, a page wsh already opened in that installed browser (FR-BRW-002). ask and keepFocus: a
// page a terminal program opened through BROWSER (FR-BRW-007, BrowserEnvRequestMeta in pkg/molten/browser.go) asks
// which engine its site uses when nothing is decided yet, and leaves the focus in the terminal. tabId and agent: a tab
// an agent opens (FR-BRW-008, BrowserAgentTabRequestMeta in pkg/molten/browser.go), with the id wavesrv chose; the
// panel never takes the focus for it.
export type BrowserOpenRequest = {
    id: string;
    url: string;
    engine?: string;
    ask?: boolean;
    keepFocus?: boolean;
    tabId?: string;
    agent?: boolean;
};

export type BrowserCloseRequest = { id: string; tabId: string };

// must match agentTabIdPrefix in pkg/molten/browseragent/tools.go
export const AgentTabIdPrefix = "agent-";

export function isAgentTabId(id: string): boolean {
    return typeof id === "string" && id.startsWith(AgentTabIdPrefix);
}

const MaxTabIdLength = 200;

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

export type BesideOpts = { notice?: string; ask?: boolean; keepFocus?: boolean };

// A browser panel shows one page (FR-SHELL-083, #1187): a page opened "in a new tab" becomes a panel of its own. Its
// block starts with that page as its single tab, keeping the tab's id when it has one (an agent's tab, a tab split out
// of an older panel), so the agents' and the panel's references to it stay valid.
export function besideBlockDef(tab: Partial<BrowserTab> & { url: string }, opts?: BesideOpts): BlockDef {
    const def = browserBlockDef(tab.url, opts?.notice, opts?.ask);
    const meta = def.meta as Record<string, any>;
    if (opts?.ask && opts?.keepFocus) {
        meta[BrowserKeepFocusMetaKey] = true;
    }
    if (tab.id) {
        const saved: Record<string, string> = { id: tab.id, url: tab.url };
        if (tab.title) {
            saved.title = tab.title;
        }
        if (tab.engine) {
            saved.engine = tab.engine;
        }
        meta[BrowserTabsMetaKey] = [saved];
        meta[BrowserActiveMetaKey] = tab.id;
    }
    return def;
}

// A panel saved with several tabs, from before panels showed one page (#1187): it keeps its shown tab, the others
// leave in their order, each to become a panel of its own. Null when the panel has one tab.
export function splitOutTabs(state: BrowserState): { kept: BrowserState; moved: BrowserTab[] } {
    if (state == null || state.tabs.length <= 1) {
        return null;
    }
    const shown = state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0];
    return {
        kept: { tabs: [shown], activeId: shown.id },
        moved: state.tabs.filter((t) => t.id !== shown.id),
    };
}

// A repository page on a project without a GitHub remote (FR-SHELL-111, viewpin.StartPageUrl): an empty page the panel
// draws MoltenTerm's start page over.
export const StartPageUrl = "about:blank#moltenterm-start";

export function isStartPage(url: string): boolean {
    return (url ?? "").trim() === StartPageUrl;
}

// An empty page a new page may replace instead of opening beside it.
export function isBlankPage(url: string): boolean {
    const text = (url ?? "").trim();
    return text === "" || text === "about:blank" || text === StartPageUrl;
}

// What the address field shows: nothing for the start page, which has no address of its own.
export function addressOfPage(url: string): string {
    return isStartPage(url) ? "" : (url ?? "");
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

export type PanelTabs = { blockId: string; state: BrowserState };

export type ServingTab = { blockId: string; tabId: string };

// The tab a replacing launch reloads instead of opening another (#1005): a page here (not a handed-off entry) that
// the launch serves, in the most recently focused panel first, then the panels last to first; in a panel, the shown
// tab first, then its tabs left to right. Null when none shows it: the launch then opens a new tab.
export function servingTabOf(panels: PanelTabs[], recent: unknown, serves: (url: string) => boolean): ServingTab {
    const list = panels ?? [];
    const recentIds = readRecentBrowserPanels(recent);
    const ordered = [
        ...recentIds.map((id) => list.find((p) => p.blockId === id)).filter((p) => p != null),
        ...[...list].reverse().filter((p) => !recentIds.includes(p.blockId)),
    ];
    for (const panel of ordered) {
        const tabs = panel.state?.tabs ?? [];
        const candidates = [...tabs.filter((t) => t.id === panel.state.activeId), ...tabs];
        const tab = candidates.find((t) => !t.engine && t.url && serves(t.url));
        if (tab != null) {
            return { blockId: panel.blockId, tabId: tab.id };
        }
    }
    return null;
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
        if (value?.agent === true && typeof value.url === "string" && value.url !== "") {
            if (typeof value.tabid === "string" && value.tabid !== "" && value.tabid.length <= MaxTabIdLength) {
                rtn.push({ id, url: value.url, tabId: value.tabid, agent: true });
            }
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

// The tabs queued for closing, in queue order.
export function readCloseRequests(meta: Record<string, any>): BrowserCloseRequest[] {
    const rtn: BrowserCloseRequest[] = [];
    for (const [key, value] of Object.entries(meta ?? {})) {
        const id = key.startsWith(BrowserCloseKeyPrefix) ? key.slice(BrowserCloseKeyPrefix.length) : "";
        if (id !== "" && typeof value === "string" && value !== "") {
            rtn.push({ id, tabId: value });
        }
    }
    return rtn.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function consumeCloseRequestsMeta(consumed: BrowserCloseRequest[]): Record<string, null> {
    const rtn: Record<string, null> = {};
    for (const request of consumed) {
        rtn[BrowserCloseKeyPrefix + request.id] = null;
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

// id: the tab's id when it is chosen elsewhere (an agent's tab, FR-BRW-008).
export type AddTabOpts = { engine?: string; activate?: boolean; id?: string };

// A new tab opens right after the active one, as in a browser, and becomes active unless opts.activate is false.
export function addTab(state: BrowserState, url: string, newId = makeTabId, opts?: AddTabOpts): BrowserState {
    if (opts?.id && state.tabs.some((t) => t.id === opts.id)) {
        return state;
    }
    const id = opts?.id || newId();
    const tab: BrowserTab = opts?.engine ? { id, url, engine: opts.engine } : { id, url };
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

// The address as the bar shows it at rest (FR-SHELL-086): without the web scheme and a lone trailing slash; other
// schemes (file:, about:) stay whole.
export function shownAddress(url: string): string {
    const text = (url ?? "").trim();
    const bare = text.replace(/^https?:\/\//i, "");
    if (bare === text) {
        return text;
    }
    return bare.replace(/^([^/?#]+)\/$/, "$1");
}

// Text that is an address rather than words to search: a scheme, localhost, an IP, or a host with a dot and no space.
// Shared by the sidebar's top field (#1187) and the panel launcher (#1229).
export function looksLikeAddress(text: string): boolean {
    const s = (text ?? "").trim();
    if (s === "" || /\s/.test(s)) {
        return false;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|file|data):/i.test(s)) {
        return true;
    }
    if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) {
        return true;
    }
    return /^[^/\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s);
}

export function addressUrl(text: string): string {
    const s = (text ?? "").trim();
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) {
        return "http://" + s;
    }
    return toBrowserUrl(s);
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
