// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What makes the flow place its blocks again (FR-SHELL-018, #2466): the companion's width, each block's size, and the
// blocks that come and go. A block is often drawn by a section that loads on its own (the workspace task, the milestone
// block, the usage): it appears, changes its element or goes on that section's state, with no render of the flow. A
// flow that only placed after its own render left such a block where the stylesheet puts it, at the flow's corner and,
// since a block is a size container, one word wide, over the blocks there, and did not follow its growth, until
// something else rendered the flow. The flow's children are watched instead, so such a block is placed before it is
// painted (a mutation observer runs before the next frame) and followed from then on.

export type FlowWatchEnv = {
    ResizeObserver: typeof ResizeObserver;
    MutationObserver: typeof MutationObserver;
};

export type FlowWatch = {
    // Observes the blocks that are now in the flow and lets go of those that left it.
    sync: () => void;
    stop: () => void;
};

export const FlowBlockSelector = ":scope > [data-flow-id]";

function defaultEnv(): FlowWatchEnv {
    if (typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") {
        return null;
    }
    return { ResizeObserver, MutationObserver };
}

// Watches flow and the companion it divides: place runs on any change of their sizes, or of the blocks the flow holds.
export function watchFlow(
    flow: HTMLElement,
    companion: Element,
    place: () => void,
    env: FlowWatchEnv = defaultEnv()
): FlowWatch {
    if (flow == null || env == null) {
        return { sync: () => {}, stop: () => {} };
    }
    const observed = new Set<Element>();
    const ro = new env.ResizeObserver(() => place());
    if (companion != null) {
        ro.observe(companion);
    }
    const sync = () => {
        const now = new Set<Element>(Array.from(flow.querySelectorAll(FlowBlockSelector)));
        observed.forEach((el) => {
            if (!now.has(el)) {
                ro.unobserve(el);
                observed.delete(el);
            }
        });
        now.forEach((el) => {
            if (!observed.has(el)) {
                ro.observe(el);
                observed.add(el);
            }
        });
    };
    const mo = new env.MutationObserver(() => {
        sync();
        place();
    });
    mo.observe(flow, { childList: true });
    sync();
    return {
        sync,
        stop: () => {
            mo.disconnect();
            ro.disconnect();
            observed.clear();
        },
    };
}
