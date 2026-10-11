// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Destroys the tab views of deleted tabs (#448, FR-PERF-002, DS-PERF-003). A workspace delete never closed the views
// windows kept for it: #68 keeps the views of a workspace left, #375 pins a view hosting a browser page, another window
// may hold one, and a delete of the workspace on screen read the workspace after deleting it, so it found no tab to
// close. Each leaked view is a hidden renderer of about 100 MB.
//
// Rather than tracking every path that deletes a tab (a workspace delete from any window, a tab close, the backend),
// a sweep asks the backend which of the tabs that have a view still exist, and destroys the others everywhere, through
// the window's removeTabView and WaveTabView.destroy (the one removal path, which logs "destroy tab"). Pins need no
// release: #301 and #375 read them live from the browser registry, which forgets a destroyed host.
//
// Never destroyed: the view on screen (a delete whose switch away failed keeps it until the window leaves it) and the
// hot spare (it has no tab yet). A backend error destroys nothing.

export type SweptTabView = {
    waveTabId: string;
    isActiveTab: boolean;
    isDestroyed: boolean;
    destroy(): void;
};

export type SweptWindow<V extends SweptTabView> = {
    waveWindowId: string;
    allLoadedTabViews: Map<string, V>;
    removeTabView(tabId: string, force: boolean): void;
};

export type TabViewSweepDeps<V extends SweptTabView> = {
    cachedViews(): V[];
    windows(): SweptWindow<V>[];
    isHotSpare(view: V): boolean;
    // The subset of `tabIds` that still exist; throws when the backend cannot tell.
    existingTabIds(tabIds: string[]): Promise<Set<string>>;
    log(msg: string, ...args: any[]): void;
};

function isSweepable<V extends SweptTabView>(view: V, deps: TabViewSweepDeps<V>): boolean {
    return view != null && view.waveTabId != null && !view.isDestroyed && !view.isActiveTab && !deps.isHotSpare(view);
}

// Every live view with a tab, whether the tab view cache, a window, or both hold it.
export function collectTabViews<V extends SweptTabView>(deps: TabViewSweepDeps<V>): V[] {
    const views = new Set<V>(deps.cachedViews());
    for (const win of deps.windows()) {
        for (const view of win.allLoadedTabViews.values()) {
            views.add(view);
        }
    }
    return Array.from(views).filter((view) => isSweepable(view, deps));
}

// Destroys one view in every window that holds it, then wherever else it lives (the cache alone).
function destroyTabView<V extends SweptTabView>(view: V, deps: TabViewSweepDeps<V>) {
    for (const win of deps.windows()) {
        if (win.allLoadedTabViews.get(view.waveTabId) === view) {
            win.removeTabView(view.waveTabId, false);
        }
    }
    if (!view.isDestroyed && !view.isActiveTab) {
        view.destroy();
    }
}

// Returns the number of views destroyed.
export async function sweepDeletedTabViews<V extends SweptTabView>(
    reason: string,
    deps: TabViewSweepDeps<V>
): Promise<number> {
    const candidates = collectTabViews(deps);
    if (candidates.length == 0) {
        return 0;
    }
    const tabIds = Array.from(new Set(candidates.map((view) => view.waveTabId)));
    let existing: Set<string>;
    try {
        existing = await deps.existingTabIds(tabIds);
    } catch (e) {
        deps.log("[#448] tab view sweep skipped, the backend did not answer", reason, e);
        return 0;
    }
    let destroyed = 0;
    for (const view of candidates) {
        // Re-checked: a view may have been shown, destroyed or given another tab while the backend answered.
        if (existing.has(view.waveTabId) || !isSweepable(view, deps) || !tabIds.includes(view.waveTabId)) {
            continue;
        }
        deps.log("[#448] destroying the view of a deleted tab", view.waveTabId, reason);
        destroyTabView(view, deps);
        destroyed++;
    }
    return destroyed;
}

// One sweep at a time; a sweep asked while one runs runs once after it (it may concern tabs deleted meanwhile), and
// further asks while that one waits share it.
export function makeTabViewSweeper<V extends SweptTabView>(
    deps: TabViewSweepDeps<V>
): (reason: string) => Promise<number> {
    let running: Promise<number> = null;
    let next: Promise<number> = null;
    return (reason: string) => {
        if (next != null) {
            return next;
        }
        if (running == null) {
            running = sweepDeletedTabViews(reason, deps).finally(() => {
                running = null;
            });
            return running;
        }
        next = running
            .catch((): number => 0)
            .then(() => {
                next = null;
                running = sweepDeletedTabViews(reason, deps).finally(() => {
                    running = null;
                });
                return running;
            });
        return next;
    };
}
