// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A tab view taken for a new tab must be ready before it is used, and no step of a window's action queue may wait on a
// renderer forever (#283). A hot spare that never reports ready used to leave the window blank until a relaunch, and a
// slow first view blocked every click queued behind it. Readiness is read from the view's state first (an event that
// already fired is not lost), a view that stays silent is dropped for a fresh one, and a view that is still silent
// after that is given up on so the queue moves on.

export const MoltentermSpareReadyTimeoutMs = 5000;
export const MoltentermFreshReadyTimeoutMs = 15000;
export const MoltentermWaveReadyTimeoutMs = 15000;

export type ReadyTrackedView = {
    isInitialized: boolean;
    isDestroyed: boolean;
    initPromise: Promise<void>;
    destroy(): void;
};

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
// ready; the caller decides what a view that is still not ready means.
export async function acquireReadyView<T extends ReadyTrackedView>(
    takeSpare: () => T,
    makeFresh: () => T,
    log: ReadyLog,
    spareMs = MoltentermSpareReadyTimeoutMs,
    freshMs = MoltentermFreshReadyTimeoutMs
): Promise<{ view: T; ready: boolean }> {
    const spare = takeSpare();
    const startSpare = Date.now();
    if (await awaitViewInitialized(spare, spareMs)) {
        return { view: spare, ready: true };
    }
    log(`spare tab view not ready after ${Date.now() - startSpare}ms, dropping it for a fresh view`);
    spare.destroy();
    const fresh = makeFresh();
    const startFresh = Date.now();
    const ready = await awaitViewInitialized(fresh, freshMs);
    if (!ready) {
        log(`fresh tab view not ready after ${Date.now() - startFresh}ms`);
    }
    return { view: fresh, ready };
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
