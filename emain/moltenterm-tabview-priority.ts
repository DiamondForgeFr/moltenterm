// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Tab view scheduling priority (#450, FR-PERF-004, DS-PERF-005). Chromium backgrounds the renderer of a view that is
// not shown: the hot spare and a view still loading off-screen ran at macOS priority 4 (background QoS, efficiency
// cores only) while the on-screen view ran at 47, so on a busy machine the first tab took 80 to 90 s. Turning a view's
// background throttling off makes Chromium treat it as shown and raises its process at once; it is per view, so the
// views kept hidden keep Chromium's normal backgrounding. A raised view is restored once it is on screen (Chromium only
// lowers it again when it is next hidden), and the spare is raised only while no view is being brought on screen, so
// it never competes with the view the user waits for.
//
// The setting moltenterm:tabviewpriority set to false restores the previous behaviour (reversible for one release).

export const TabViewPrioritySetting = "moltenterm:tabviewpriority";

export type PriorityView = {
    isDestroyed: boolean;
    webContents: { setBackgroundThrottling(allowed: boolean): void; isDestroyed(): boolean };
};

type PriorityState = {
    enabled: boolean;
    raised: WeakSet<object>;
    showing: number;
    currentSpare: () => PriorityView;
};

const state: PriorityState = {
    enabled: true,
    raised: new WeakSet<object>(),
    showing: 0,
    currentSpare: null,
};

export function noteTabViewPrioritySetting(fullConfig: FullConfigType) {
    state.enabled = (fullConfig?.settings as Record<string, unknown>)?.[TabViewPrioritySetting] !== false;
}

export function isTabViewPriorityEnabled(): boolean {
    return state.enabled;
}

export function isTabViewPriorityRaised(view: PriorityView): boolean {
    return view != null && state.raised.has(view);
}

function isLive(view: PriorityView): boolean {
    return view != null && !view.isDestroyed && !view.webContents.isDestroyed();
}

export function raiseTabViewPriority(view: PriorityView) {
    if (!state.enabled || !isLive(view) || state.raised.has(view)) {
        return;
    }
    state.raised.add(view);
    view.webContents.setBackgroundThrottling(false);
}

export function restoreTabViewPriority(view: PriorityView) {
    if (view == null || !state.raised.has(view)) {
        return;
    }
    state.raised.delete(view);
    if (!isLive(view)) {
        return;
    }
    view.webContents.setBackgroundThrottling(true);
}

// `currentSpare` is read when the spare is raised: by then it may have been taken for a tab, or replaced.
export function raiseSparePriority(currentSpare: () => PriorityView) {
    state.currentSpare = currentSpare;
    if (state.showing > 0) {
        return;
    }
    raiseTabViewPriority(currentSpare());
}

// Brackets the work of bringing a view on screen (a window action); the spare waits for the last one to end.
export function beginTabViewWork() {
    state.showing++;
}

export function endTabViewWork() {
    state.showing = Math.max(0, state.showing - 1);
    if (state.showing > 0 || state.currentSpare == null) {
        return;
    }
    raiseTabViewPriority(state.currentSpare());
}

export function resetTabViewPriorityForTests() {
    state.enabled = true;
    state.raised = new WeakSet<object>();
    state.showing = 0;
    state.currentSpare = null;
}
