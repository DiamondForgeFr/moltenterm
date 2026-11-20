// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The 360 view's two on-demand chunks (#2433): the chooser's popover and the carpet's tab strip stay out of the entry
// chunk (NFR-PERF-003, bundle.initialJsMB), and load as soon as the tab wants the 360 view, or when the window is idle,
// so nothing appears late on the first entry and the keys of the chooser are not lost while it loads. This file imports
// nothing heavy itself.

const IdleFallbackMs = 3000;

let started = false;

// Whether this is the app's window: no preload API, no chunk to fetch (a test, a preview).
function inApp(): boolean {
    return typeof window !== "undefined" && (window as { api?: unknown }).api != null;
}

export function prefetchView360Chunks(): void {
    if (started || !inApp()) {
        return;
    }
    started = true;
    const loaded = [import("./view360-places-chooser"), import("./view360-radar")];
    for (const load of loaded) {
        // A chunk that did not load is fetched again when it is used, and when the next prefetch asks.
        load.catch(() => {
            started = false;
        });
    }
}

export function prefetchView360WhenIdle(): void {
    if (started || !inApp()) {
        return;
    }
    const idle = window.requestIdleCallback?.bind(window);
    if (idle != null) {
        idle(() => prefetchView360Chunks());
        return;
    }
    setTimeout(prefetchView360Chunks, IdleFallbackMs);
}
