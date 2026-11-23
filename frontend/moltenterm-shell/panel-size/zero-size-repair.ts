// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A saved layout never keeps a panel at size 0 (#2497). Sizes are flex weights: a child at 0 among siblings gets no
// width (or height) at all, so its panel is in the tab, counted by the view's tile, and invisible, with no divider to
// drag it back. Nothing in the app collapses a panel on purpose this way (a panel is closed, magnified over the others
// or put on the 360 view's carpet instead), so a size of 0 is always damage: the layout repairs it when it loads, giving
// the panel the average share of its siblings. Pure, so it is tested without a window.

import { DefaultNodeSize, type LayoutNode } from "@/layout/lib/types";

function usable(size: number): boolean {
    return typeof size === "number" && Number.isFinite(size) && size > 0;
}

// Gives every child at size 0 (or a size that is no number) the average size of its siblings, in the whole tree;
// returns whether a size changed. The tree is changed in place, as the layout's own reducers do.
export function repairZeroSizes(node: LayoutNode): boolean {
    const children = node?.children;
    if (!children?.length) {
        return false;
    }
    let changed = false;
    if (children.length > 1) {
        const kept = children.map((c) => c.size).filter(usable);
        const share = kept.length > 0 ? kept.reduce((acc, s) => acc + s, 0) / kept.length : DefaultNodeSize;
        for (const child of children) {
            if (!usable(child.size)) {
                child.size = share;
                changed = true;
            }
        }
    }
    for (const child of children) {
        changed = repairZeroSizes(child) || changed;
    }
    return changed;
}
