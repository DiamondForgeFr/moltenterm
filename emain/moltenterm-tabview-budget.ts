// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Hidden tab view budget and real hiding (#454, FR-PERF-008, DS-PERF-007). Wave kept up to 10 cached tab views per
// app and parked the hidden ones at -15000 px, at full window size, never hidden. Measured at 6 workspaces: 1653 MB in
// all, a GPU process of 863 MB, about 117 MB of GPU memory per hidden view: the tiles of the last frame Chromium keeps
// for a hidden view (up to 5 of them, released only under system memory pressure; neither hiding nor detaching the
// view frees them, no Electron API evicts them) and the WebGL drawing buffers of its terminals.
//
// Three changes, all behind moltenterm:tabviewbudget (default on; false restores the previous behaviour):
// - a view parked off-screen is also hidden (View.setVisible(false)). On macOS Chromium already treated an off-screen
//   view as occluded, as a heuristic; hiding makes the page hidden on every platform, with the standard
//   visibilitychange events that the frontend's visibility gates and #455's activity model read, and it lowers the
//   renderer's own memory (about 75 to 60 MB). A view is shown again before its reinit and whenever it is put on
//   screen; #223's probe still checks it paints once on screen.
// - a terminal hidden for a while gives its WebGL buffers back (frontend/moltenterm-shell/term-visibility/).
// - at most N hidden views (moltenterm:hiddentabviews, 1 to 10, default 3) and M MB for all of them together
//   (moltenterm:hiddentabviewsmb) stay cached; past that the least recently used are destroyed. Terminals run in
//   wavesrv, so an evicted workspace is rebuilt from the hot spare with its terminals reattached (as after #199's
//   wake eviction). Never evicted: a view on screen, the hot spare (not cached), a view being shown or used in the
//   last second, a view an agent drives a browser tab in (#301), whose workspace has a working agent, or whose
//   renderer holds unsaved work, asked just before (#476) (pinned, counted within the budget). A view holding a
//   browser page (#375) goes after the other hidden views: its page is reloaded at its URL when the workspace is
//   shown again.

export const TabViewBudgetSetting = "moltenterm:tabviewbudget";
export const HiddenTabViewsSetting = "moltenterm:hiddentabviews";
export const HiddenTabViewsMemorySetting = "moltenterm:hiddentabviewsmb";

export const DefaultHiddenTabViews = 3;
export const MinHiddenTabViews = 1;
export const MaxHiddenTabViews = 10;
// Sum of the hidden views' resident memory as Electron reports it (app.getAppMetrics workingSetSize, which counts
// shared pages too): generous, so the count is what normally binds and the memory budget only catches a bloated view.
export const DefaultHiddenTabViewsMb = 1200;
export const MinHiddenTabViewsMb = 200;
export const MaxHiddenTabViewsMb = 8000;
// A view used this recently is in the middle of something (a switch that just showed or left it).
export const RecentlyUsedMs = 1000;

export type TabViewBudgetConfig = {
    enabled: boolean;
    maxHidden: number;
    maxHiddenMb: number;
};

function clampSetting(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(value)));
}

export function readTabViewBudgetConfig(settings: Record<string, unknown>): TabViewBudgetConfig {
    return {
        enabled: settings?.[TabViewBudgetSetting] !== false,
        maxHidden: clampSetting(
            settings?.[HiddenTabViewsSetting],
            MinHiddenTabViews,
            MaxHiddenTabViews,
            DefaultHiddenTabViews
        ),
        maxHiddenMb: clampSetting(
            settings?.[HiddenTabViewsMemorySetting],
            MinHiddenTabViewsMb,
            MaxHiddenTabViewsMb,
            DefaultHiddenTabViewsMb
        ),
    };
}

type BudgetState = {
    config: TabViewBudgetConfig;
    showing: WeakMap<object, number>;
    workspaceOf: WeakMap<object, string>;
    leftScreenAt: WeakMap<object, number>;
};

const state: BudgetState = {
    config: readTabViewBudgetConfig(null),
    showing: new WeakMap<object, number>(),
    workspaceOf: new WeakMap<object, string>(),
    leftScreenAt: new WeakMap<object, number>(),
};

export function noteTabViewBudgetSettings(settings: Record<string, unknown>) {
    const next = readTabViewBudgetConfig(settings);
    const prev = state.config;
    state.config = next;
    if (prev.enabled !== next.enabled || prev.maxHidden !== next.maxHidden || prev.maxHiddenMb !== next.maxHiddenMb) {
        console.log("[#454] tab view budget", JSON.stringify(next));
    }
}

export function getTabViewBudgetConfig(): TabViewBudgetConfig {
    return state.config;
}

export function isTabViewBudgetEnabled(): boolean {
    return state.config.enabled;
}

// A view being brought on screen (a window action shows it) is never hidden nor evicted meanwhile.
export function beginShowingTabView(view: object) {
    if (view == null) {
        return;
    }
    state.showing.set(view, (state.showing.get(view) ?? 0) + 1);
}

export function endShowingTabView(view: object) {
    if (view == null) {
        return;
    }
    const n = (state.showing.get(view) ?? 0) - 1;
    if (n <= 0) {
        state.showing.delete(view);
        return;
    }
    state.showing.set(view, n);
}

export function isShowingTabView(view: object): boolean {
    return view != null && state.showing.has(view);
}

// The workspace a view was last shown for: an agent working there pins it.
export function noteTabViewWorkspace(view: object, workspaceId: string) {
    if (view == null || workspaceId == null) {
        return;
    }
    state.workspaceOf.set(view, workspaceId);
}

export function tabViewWorkspace(view: object): string {
    return view == null ? null : (state.workspaceOf.get(view) ?? null);
}

// Wave's lastUsedTs is when a view was last taken for its tab; a view used until it left the screen just now is not
// the least recently used.
export function noteTabViewLeftScreenForBudget(view: object) {
    if (view == null) {
        return;
    }
    state.leftScreenAt.set(view, Date.now());
}

function lastUsedAt(view: { lastUsedTs: number }): number {
    return Math.max(view.lastUsedTs ?? 0, state.leftScreenAt.get(view) ?? 0);
}

export type HideableTabView = {
    isDestroyed: boolean;
    getVisible(): boolean;
    setVisible(visible: boolean): void;
};

function isLive(view: HideableTabView): boolean {
    return view != null && !view.isDestroyed;
}

// Called for a view just parked off-screen. Returns whether it was hidden now.
export function hideParkedTabView(view: HideableTabView): boolean {
    if (!state.config.enabled || !isLive(view) || isShowingTabView(view) || !view.getVisible()) {
        return false;
    }
    view.setVisible(false);
    return true;
}

// Called before a view is shown again, and whenever it is put on screen: a view hidden while the budget was on is
// shown even when the budget has been turned off since. Returns whether it was hidden.
export function revealTabView(view: HideableTabView): boolean {
    if (!isLive(view) || view.getVisible()) {
        return false;
    }
    view.setVisible(true);
    return true;
}

export type BudgetCandidate<V> = {
    view: V;
    lastUsedTs: number;
    // On screen in a window, or the hot spare: neither counts nor goes.
    onScreen: boolean;
    pinned: boolean;
    busy: boolean;
    keepsPage: boolean;
    memoryMb: number;
};

// The hidden views to destroy so that at most cfg.maxHidden of them stay and their memory fits cfg.maxHiddenMb.
// Pinned and busy views count and stay; views keeping a browser page go after the others; then least recently used.
export function chooseTabViewsToEvict<V>(candidates: BudgetCandidate<V>[], cfg: TabViewBudgetConfig): V[] {
    if (!cfg.enabled) {
        return [];
    }
    const hidden = candidates.filter((c) => !c.onScreen);
    let count = hidden.length;
    let memory = hidden.reduce((sum, c) => sum + (c.memoryMb ?? 0), 0);
    const evictable = hidden
        .filter((c) => !c.pinned && !c.busy)
        .sort((a, b) => Number(a.keepsPage) - Number(b.keepsPage) || (a.lastUsedTs ?? 0) - (b.lastUsedTs ?? 0));
    const out: V[] = [];
    for (const c of evictable) {
        if (count <= cfg.maxHidden && memory <= cfg.maxHiddenMb) {
            break;
        }
        out.push(c.view);
        count--;
        memory -= c.memoryMb ?? 0;
    }
    return out;
}

export type BudgetTabView = {
    waveTabId: string;
    isActiveTab: boolean;
    isDestroyed: boolean;
    isWaveReady: boolean;
    lastUsedTs: number;
};

export type TabViewBudgetDeps<V extends BudgetTabView> = {
    // Every live view with a tab (the cache and the windows').
    tabViews(): V[];
    isHotSpare(view: V): boolean;
    isPinned(view: V): boolean;
    keepsPage(view: V): boolean;
    // Asked of each view about to be destroyed: work that lives only in its renderer (an edited file not saved,
    // frontend/moltenterm-shell/unsaved-work.ts) pins it. A view that cannot answer counts as holding some.
    hasUnsavedWork(view: V): Promise<boolean>;
    // Resident memory of each view's renderer, in MB; views missing from it count as 0.
    memoryMb(views: V[]): Map<V, number>;
    evict(view: V): void;
    log(msg: string, ...args: any[]): void;
    now(): number;
};

function isEvictable(view: BudgetTabView): boolean {
    return !view.isDestroyed && !view.isActiveTab && !isShowingTabView(view);
}

// Returns the number of views destroyed.
export async function enforceTabViewBudget<V extends BudgetTabView>(deps: TabViewBudgetDeps<V>): Promise<number> {
    const cfg = state.config;
    if (!cfg.enabled) {
        return 0;
    }
    const views = deps
        .tabViews()
        .filter((v) => v != null && v.waveTabId != null && !v.isDestroyed && !deps.isHotSpare(v));
    const hiddenCount = views.filter((v) => !v.isActiveTab).length;
    if (hiddenCount === 0) {
        return 0;
    }
    const memory = deps.memoryMb(views.filter((v) => !v.isActiveTab));
    const now = deps.now();
    let candidates: BudgetCandidate<V>[] = views.map((view) => ({
        view,
        lastUsedTs: lastUsedAt(view),
        onScreen: view.isActiveTab,
        pinned: deps.isPinned(view),
        busy: isShowingTabView(view) || !view.isWaveReady || now - lastUsedAt(view) < RecentlyUsedMs,
        keepsPage: deps.keepsPage(view),
        memoryMb: memory.get(view) ?? 0,
    }));
    let evicted = 0;
    // One victim at a time: a view found holding unsaved work is pinned and the choice is made again, so the next
    // least recently used goes instead.
    for (;;) {
        const victim = chooseTabViewsToEvict(candidates, cfg)[0];
        if (victim == null) {
            return evicted;
        }
        const candidate = candidates.find((c) => c.view === victim);
        if (!isEvictable(victim)) {
            candidate.busy = true;
            continue;
        }
        if (await deps.hasUnsavedWork(victim)) {
            deps.log("[#476] tab view budget: keeping a hidden view that holds unsaved work", victim.waveTabId);
            candidate.pinned = true;
            continue;
        }
        if (!isEvictable(victim)) {
            candidate.busy = true;
            continue;
        }
        deps.log(
            `[#454] tab view budget: destroying the least recently used hidden view (${hiddenCount} hidden, budget ${cfg.maxHidden} views / ${cfg.maxHiddenMb} MB)`,
            victim.waveTabId
        );
        deps.evict(victim);
        candidates = candidates.filter((c) => c !== candidate);
        evicted++;
    }
}

// One enforcement at a time; one asked while another runs runs once after it.
export function makeSerialBudgetRunner(run: () => Promise<number>): () => Promise<number> {
    let running: Promise<number> = null;
    let again = false;
    const start = (): Promise<number> => {
        running = run()
            .catch((): number => 0)
            .finally(() => {
                running = null;
                if (again) {
                    again = false;
                    start();
                }
            });
        return running;
    };
    return () => {
        if (running != null) {
            again = true;
            return running;
        }
        return start();
    };
}

export function resetTabViewBudgetForTests() {
    state.config = readTabViewBudgetConfig(null);
    state.showing = new WeakMap<object, number>();
    state.workspaceOf = new WeakMap<object, string>();
    state.leftScreenAt = new WeakMap<object, number>();
}
