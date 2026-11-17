// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// When Brokk's live portrait fails to load or to draw, the still stands in for it and the portrait is tried again
// (FR-BOSS-009, AC1, #2219): he is animated whenever his face is visible, so one error must not leave a still for the rest
// of the mount. Pure and driven by the timers it is handed, so the rules are tested without a wait.

// The pause before the first retry, the second, and every later one. The last one repeats: a portrait that cannot load
// is tried about once a minute, which costs nothing while it keeps failing.
export const RetryDelaysMs: readonly number[] = [2000, 10000, 60000];

// A retry that is followed by this long without a new failure has worked: the next failure starts from the short pause.
export const StableAfterMs = 30000;

export function retryDelayMs(failures: number): number {
    const index = Math.min(Math.max(failures, 1), RetryDelaysMs.length) - 1;
    return RetryDelaysMs[index];
}

export type LiveRetryDeps = {
    setTimer: (run: () => void, ms: number) => unknown;
    clearTimer: (timer: unknown) => void;
    // The boundary renders its children again.
    retry: () => void;
};

export class LiveRetry {
    deps: LiveRetryDeps;
    failures = 0;
    retryTimer: unknown = null;
    stableTimer: unknown = null;

    constructor(deps: LiveRetryDeps) {
        this.deps = deps;
    }

    failed(): void {
        this.cancel();
        this.failures++;
        this.retryTimer = this.deps.setTimer(() => this.due(), retryDelayMs(this.failures));
    }

    due(): void {
        this.retryTimer = null;
        this.stableTimer = this.deps.setTimer(() => this.settled(), StableAfterMs);
        this.deps.retry();
    }

    settled(): void {
        this.stableTimer = null;
        this.failures = 0;
    }

    // The boundary left the page: nothing is retried for a face nobody sees.
    cancel(): void {
        if (this.retryTimer != null) {
            this.deps.clearTimer(this.retryTimer);
        }
        if (this.stableTimer != null) {
            this.deps.clearTimer(this.stableTimer);
        }
        this.retryTimer = null;
        this.stableTimer = null;
    }
}
