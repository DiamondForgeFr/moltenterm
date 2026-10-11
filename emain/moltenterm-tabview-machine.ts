// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The tab view state machine (#461, FR-PERF-015, DS-PERF-013). Wave's tab view path grew five patches (#68, #199, #223,
// #283, #375), then #448, #449, #450 and #454, and a view's state was spread over flags that could disagree: Wave's
// isInitialized, isWaveReady, isActiveTab and isDestroyed, an entry in the tab view cache and another in its window's
// map. A view left in the cache by no window, or shown after its tab was deleted, was the cause of #448 and #449.
//
// Here every view has one state, changed only along the transitions below, and one owner: the tab view host while it
// is a spare, then the one window it was given to. The registry also keeps the tab view cache (the newest live view of
// each tab) and each window's active view, so nothing else has to agree with it. The Electron side is the tab view
// host (emain/moltenterm-tabview-host.ts).
//
//   (new view)
//       │
//       ▼          given to a tab                rendered                activated
//     spare ──────────────────────► loading ──────────────► ready ──────────────────────┐
//       │                           │   │                                              ▼
//       │                           │   └─── activated while loading ─────────────► shown ◄────┐
//       │                           │        (the window's first tab; Wave's flow      │       │ shown
//       │                           │        for a new tab), shown once rendered        │       │ again
//       │                           ▼                                    another view  ▼       │
//       │                        failed ◄── readiness deadline missed    is shown   hidden ────┘
//       │                           │       twice (#450)                                │
//       └──────────────┬────────────┴──────────────────────────────────────────────────┘
//                      ▼   destroy(): tab closed or deleted, budget, cache size, wake, window closed,
//                  evicting           superseded switch, failed view, paint check rebuild
//                      │   its renderer closed
//                      ▼
//                  destroyed      (a renderer that goes away by itself takes any state straight here)
//
// Any other transition is invalid: it throws when the registry is strict (dev builds and the unit tests) and is
// logged otherwise, then applied, so that production behaviour never depends on the check.

export type TabViewState = "spare" | "loading" | "ready" | "shown" | "hidden" | "evicting" | "destroyed" | "failed";

export const TabViewTransitions: Readonly<Record<TabViewState, readonly TabViewState[]>> = {
    spare: ["loading", "evicting", "destroyed"],
    loading: ["ready", "shown", "failed", "evicting", "destroyed"],
    ready: ["shown", "evicting", "destroyed"],
    shown: ["hidden", "evicting", "destroyed"],
    hidden: ["shown", "evicting", "destroyed"],
    failed: ["evicting", "destroyed"],
    evicting: ["destroyed"],
    destroyed: [],
};

const LiveStates: ReadonlySet<TabViewState> = new Set<TabViewState>([
    "spare",
    "loading",
    "ready",
    "shown",
    "hidden",
    "failed",
]);

export function isAllowedTransition(from: TabViewState, to: TabViewState): boolean {
    return TabViewTransitions[from]?.includes(to) ?? false;
}

// `to` is null for an operation that changes no state but breaks the ownership rule.
export class InvalidTabViewTransition extends Error {
    constructor(
        readonly from: TabViewState,
        readonly to: TabViewState,
        readonly detail: string
    ) {
        super(
            to == null
                ? `invalid tab view operation on a ${from ?? "unknown"} view: ${detail}`
                : `invalid tab view transition ${from ?? "(unknown view)"} → ${to}: ${detail}`
        );
        this.name = "InvalidTabViewTransition";
    }
}

export type TabViewEntry = {
    state: TabViewState;
    tabId: string;
    // The owner: null while the view is a spare (the host's), then the window it was given to, for good.
    windowId: string;
    // The window counts the view among its own (Wave's allLoadedTabViews): from the moment it starts showing it.
    adopted: boolean;
    since: number;
};

export type TabViewRegistryOpts = {
    strict(): boolean;
    log(msg: string): void;
    now(): number;
};

export type TabViewSnapshotEntry = {
    tabId: string;
    windowId: string;
    state: TabViewState;
    adopted: boolean;
    active: boolean;
    forMs: number;
};

export class TabViewRegistry<V extends object> {
    entries = new Map<V, TabViewEntry>();
    byTab = new Map<string, V>();
    activeByWindow = new Map<string, V>();
    invalidCount = 0;

    constructor(readonly opts: TabViewRegistryOpts) {}

    has(view: V): boolean {
        return view != null && this.entries.has(view);
    }

    stateOf(view: V): TabViewState {
        return view == null ? null : (this.entries.get(view)?.state ?? null);
    }

    isLive(view: V): boolean {
        return LiveStates.has(this.stateOf(view));
    }

    windowOf(view: V): string {
        return view == null ? null : (this.entries.get(view)?.windowId ?? null);
    }

    viewForTab(tabId: string): V {
        return tabId == null ? null : (this.byTab.get(tabId) ?? null);
    }

    activeOf(windowId: string): V {
        return windowId == null ? null : (this.activeByWindow.get(windowId) ?? null);
    }

    isActive(view: V): boolean {
        const windowId = this.windowOf(view);
        return windowId != null && this.activeByWindow.get(windowId) === view;
    }

    // Every live view given to a tab, whether a window counts it yet or not.
    tabViews(): V[] {
        const out: V[] = [];
        for (const [view, entry] of this.entries) {
            if (entry.tabId != null && LiveStates.has(entry.state)) {
                out.push(view);
            }
        }
        return out;
    }

    // The views a window counts as its own, by tab: what Wave kept in the window's allLoadedTabViews.
    windowViews(windowId: string): Map<string, V> {
        const out = new Map<string, V>();
        if (windowId == null) {
            return out;
        }
        for (const [view, entry] of this.entries) {
            if (entry.windowId === windowId && entry.adopted && LiveStates.has(entry.state)) {
                out.set(entry.tabId, view);
            }
        }
        return out;
    }

    // (new) → spare
    add(view: V) {
        if (this.entries.has(view)) {
            this.invalid(this.stateOf(view), "spare", "a view is created once");
            return;
        }
        this.entries.set(view, { state: "spare", tabId: null, windowId: null, adopted: false, since: this.opts.now() });
    }

    // spare → loading: the view is given to a tab and to the window that asked for it, its one owner from now on.
    assign(view: V, tabId: string, windowId: string, reason: string) {
        const entry = this.entryFor(view, "loading", reason);
        if (entry == null) {
            return;
        }
        if (entry.windowId != null && entry.windowId !== windowId) {
            this.invalid(entry.state, null, `${reason}: given to window ${windowId}, owned by ${entry.windowId}`);
        }
        this.move(entry, "loading", reason);
        entry.tabId = tabId;
        entry.windowId = windowId;
        this.byTab.set(tabId, view);
    }

    adopt(view: V, windowId: string) {
        const entry = this.entries.get(view);
        if (entry == null || !LiveStates.has(entry.state)) {
            this.invalid(entry?.state ?? null, null, `adopted by window ${windowId} while not live`);
            return;
        }
        if (entry.windowId !== windowId) {
            this.invalid(entry.state, null, `adopted by window ${windowId}, owned by ${entry.windowId}`);
            return;
        }
        entry.adopted = true;
    }

    // loading → ready, or → shown when its window already made it the active view (activated while loading).
    markReady(view: V, reason: string): TabViewState {
        const entry = this.entryFor(view, "ready", reason);
        if (entry == null) {
            return null;
        }
        const to: TabViewState = this.isActive(view) ? "shown" : "ready";
        this.move(entry, to, reason);
        return to;
    }

    // The window makes `view` its active view (null: none). The previous active view is hidden; a view still loading
    // stays loading (it is shown once rendered). Returns the previous active view.
    activate(windowId: string, view: V, reason: string): V {
        const prev = this.activeOf(windowId);
        if (view != null) {
            const entry = this.entryFor(view, "shown", reason);
            if (entry != null && entry.windowId !== windowId) {
                this.invalid(entry.state, null, `${reason}: shown in window ${windowId}, owned by ${entry.windowId}`);
            }
        }
        if (prev != null && prev !== view) {
            const prevEntry = this.entries.get(prev);
            if (prevEntry?.state === "shown") {
                this.move(prevEntry, "hidden", "another view is shown");
            }
        }
        if (view == null) {
            this.activeByWindow.delete(windowId);
            return prev;
        }
        this.activeByWindow.set(windowId, view);
        const entry = this.entries.get(view);
        if (entry != null && entry.state !== "loading") {
            this.move(entry, "shown", reason);
        }
        return prev;
    }

    // loading → failed
    fail(view: V, reason: string) {
        const entry = this.entryFor(view, "failed", reason);
        if (entry != null) {
            this.move(entry, "failed", reason);
        }
    }

    // A live view goes: it leaves the tab view cache, its window's views and its window's active slot at once, and its
    // renderer closes. Returns false for a view already going (destroy is idempotent).
    evict(view: V, reason: string): boolean {
        const entry = this.entries.get(view);
        if (entry == null) {
            this.invalid(null, "evicting", reason);
            return false;
        }
        if (entry.state === "evicting" || entry.state === "destroyed") {
            return false;
        }
        this.move(entry, "evicting", reason);
        this.unindex(view, entry);
        return true;
    }

    // Its renderer is gone, from any state; the view is forgotten.
    destroyed(view: V, reason: string) {
        const entry = this.entries.get(view);
        if (entry == null) {
            return;
        }
        this.move(entry, "destroyed", reason);
        this.unindex(view, entry);
        this.entries.delete(view);
    }

    snapshot(): TabViewSnapshotEntry[] {
        const now = this.opts.now();
        return Array.from(this.entries, ([view, entry]) => ({
            tabId: entry.tabId,
            windowId: entry.windowId,
            state: entry.state,
            adopted: entry.adopted,
            active: this.isActive(view),
            forMs: now - entry.since,
        }));
    }

    private entryFor(view: V, to: TabViewState, reason: string): TabViewEntry {
        const entry = view == null ? null : this.entries.get(view);
        if (entry == null) {
            this.invalid(null, to, reason);
            return null;
        }
        return entry;
    }

    private unindex(view: V, entry: TabViewEntry) {
        if (entry.tabId != null && this.byTab.get(entry.tabId) === view) {
            this.byTab.delete(entry.tabId);
        }
        if (entry.windowId != null && this.activeByWindow.get(entry.windowId) === view) {
            this.activeByWindow.delete(entry.windowId);
        }
        entry.adopted = false;
    }

    private move(entry: TabViewEntry, to: TabViewState, reason: string) {
        if (entry.state === to) {
            return;
        }
        if (!isAllowedTransition(entry.state, to)) {
            this.invalid(
                entry.state,
                to,
                `${reason} (tab ${entry.tabId ?? "none"}, window ${entry.windowId ?? "none"})`
            );
        }
        entry.state = to;
        entry.since = this.opts.now();
    }

    private invalid(from: TabViewState, to: TabViewState, detail: string) {
        this.invalidCount++;
        const err = new InvalidTabViewTransition(from, to, detail);
        if (this.opts.strict()) {
            throw err;
        }
        this.opts.log(`[#461] ${err.message}`);
    }
}
