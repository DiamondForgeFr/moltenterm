// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The view's one moment (theme Coulée's rule 5, FR-SHELL-112): the pour of a switch holds it, and a panel arriving
// meanwhile waits for it to end (panel-arrival-model.ts). Kept apart from the components so that the layout model
// can read it without loading React or a stylesheet.

let momentEndsAt = 0;
const pourListeners = new Set<() => void>();

function now(): number {
    return globalThis.performance?.now?.() ?? 0;
}

// A pour of ms started now.
export function markPour(ms: number) {
    momentEndsAt = now() + Math.max(0, ms);
}

// How long a moment that wants to play now has to wait for the pour, in ms.
export function pourWaitMs(at = now()): number {
    return Math.max(0, Math.round(momentEndsAt - at));
}

// cb runs after each switch to this view, once its pour has started (or would have, under reduced motion).
export function onViewPour(cb: () => void): () => void {
    pourListeners.add(cb);
    return () => {
        pourListeners.delete(cb);
    };
}

export function notifyViewPour() {
    for (const cb of Array.from(pourListeners)) {
        cb();
    }
}

export function resetPourMomentForTest() {
    momentEndsAt = 0;
    pourListeners.clear();
}
