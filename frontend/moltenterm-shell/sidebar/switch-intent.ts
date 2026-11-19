// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The intent a pointer on a workspace's dot gives main (#2375): the pointer must stay on the dot this long before main
// reads the view back and decodes that workspace's picture. A sweep across the dots stops on none of them and sends
// nothing: each send costs a picture's bytes to the view on screen and to the warm target, and a decode in both.
export const SwitchIntentDwellMs = 100;

export type SwitchIntentTimer = {
    schedule(fn: () => void, ms: number): unknown;
    cancel(handle: unknown): void;
};

const liveTimer: SwitchIntentTimer = {
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function makeSwitchIntent(send: (workspaceId: string) => void, timer: SwitchIntentTimer = liveTimer) {
    let pending: unknown = null;
    const cancel = () => {
        if (pending == null) {
            return;
        }
        timer.cancel(pending);
        pending = null;
    };
    return {
        enter(workspaceId: string) {
            cancel();
            pending = timer.schedule(() => {
                pending = null;
                send(workspaceId);
            }, SwitchIntentDwellMs);
        },
        leave: cancel,
    };
}
