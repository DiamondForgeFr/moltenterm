// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A tab view taken for a new tab must be ready before it is used, and no step of a window's action queue may wait on a
// renderer forever (#283). A hot spare that never reports ready used to leave the window blank until a relaunch, and a
// slow first view blocked every click queued behind it. Readiness is read from the view's state first (an event that
// already fired is not lost), a view that stays silent is dropped for a fresh one, and a view that is still silent
// after that is given up on so the queue moves on. Both share the action's single readiness deadline (#449).

export const MoltentermSpareReadyTimeoutMs = 5000;

export type ReadyTrackedView = {
    isInitialized: boolean;
    isDestroyed: boolean;
    createdTs: number;
    initPromise: Promise<void>;
    destroy(): void;
};

export type AcquiredView<T> = { view: T; ready: boolean; cancelled?: boolean };

export type ReadyLog = (msg: string) => void;

export async function awaitViewInitialized(view: ReadyTrackedView, ms: number): Promise<boolean> {
    if (view.isDestroyed) {
        return false;
    }
    if (view.isInitialized) {
        return true;
    }
    let timer: ReturnType<typeof setTimeout> = null;
    const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
    });
    try {
        return await Promise.race([view.initPromise.then(() => true), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

// Takes a spare, waits for it, replaces it by a fresh view when it stays silent. Returns the view and whether it is
// ready by the deadline (ms since epoch); the caller decides what a view that is still not ready means. When
// `cancelled` resolves first (the action was superseded, #449), returns at once with `cancelled` set and the view not
// assigned to anything, for the caller to keep as a spare.
export async function acquireReadyView<T extends ReadyTrackedView>(
    takeSpare: () => T,
    makeFresh: () => T,
    log: ReadyLog,
    deadline: number,
    cancelled: Promise<void> = null,
    spareMs = MoltentermSpareReadyTimeoutMs
): Promise<AcquiredView<T>> {
    const spare = takeSpare();
    const startSpare = Date.now();
    const remaining = Math.max(0, deadline - startSpare);
    // A spare still within its normal boot time is waited for until the deadline: dropping it would start a renderer
    // from zero. Only a spare older than that and still silent is suspected stale (#283): it gets half of what is left.
    const young = startSpare - spare.createdTs < spareMs;
    const spareReady = await raceCancelled(
        awaitViewInitialized(spare, young ? remaining : Math.min(spareMs, remaining / 2)),
        cancelled
    );
    if (spareReady == null) {
        return { view: spare, ready: spare.isInitialized, cancelled: true };
    }
    if (spareReady) {
        return { view: spare, ready: true };
    }
    if (young) {
        log(`spare tab view not ready after ${Date.now() - startSpare}ms (readiness deadline)`);
        return { view: spare, ready: false };
    }
    log(`spare tab view not ready after ${Date.now() - startSpare}ms, dropping it for a fresh view`);
    spare.destroy();
    const fresh = makeFresh();
    const startFresh = Date.now();
    const ready = await raceCancelled(awaitViewInitialized(fresh, Math.max(0, deadline - startFresh)), cancelled);
    if (ready == null) {
        return { view: fresh, ready: fresh.isInitialized, cancelled: true };
    }
    if (!ready) {
        log(`fresh tab view not ready after ${Date.now() - startFresh}ms`);
    }
    return { view: fresh, ready };
}

// null when `cancelled` resolves first
function raceCancelled(p: Promise<boolean>, cancelled: Promise<void>): Promise<boolean> {
    if (cancelled == null) {
        return p;
    }
    return Promise.race([p, cancelled.then((): boolean => null)]);
}

export type QueuedSwitch = { op: string; workspaceId?: string };

// A click on the workspace a pending switch already targets adds nothing: the last queued entry is what runs last.
export function isDuplicateSwitch(queue: QueuedSwitch[], workspaceId: string): boolean {
    if (queue.length === 0) {
        return false;
    }
    const last = queue[queue.length - 1];
    return last.op === "switchworkspace" && last.workspaceId === workspaceId;
}
