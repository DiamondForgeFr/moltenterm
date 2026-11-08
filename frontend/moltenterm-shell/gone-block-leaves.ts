// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A block deleted without the layout being told (ObjectService.DeleteBlock straight from a view, as the onboarding
// sign-in terminal does once the sign-in succeeds) used to leave its leaf behind: an empty place in the grid, a blank
// "Panel" tab in the 360 view's strip and nothing sliding in to fill it (#1739). The layout now follows the tab: a
// block that leaves the tab's block list takes its leaf with it, whatever removed it.

import type { Atom } from "jotai";

type StoreLike = {
    get: <T>(atom: Atom<T>) => T;
    sub: (atom: Atom<unknown>, listener: () => void) => () => void;
};

export type GoneBlockLayout = {
    getNodeByBlockId: (blockId: string) => { id: string };
    // Drops the leaf from the layout only: the block is already gone, or lives on in another tab.
    dropLeafNode: (nodeId: string) => void;
};

// The blocks in `before` that are no longer in `after`. Only a block the tab held before counts: a leaf whose block
// has not reached the tab's list yet (a layout action ahead of the tab's update) is never dropped.
export function goneBlockIds(before: string[], after: string[]): string[] {
    if (!before?.length) {
        return [];
    }
    const now = new Set(after ?? []);
    return before.filter((id) => !!id && !now.has(id));
}

export function watchGoneBlockLeaves(store: StoreLike, tabAtom: Atom<Tab>, layout: GoneBlockLayout): () => void {
    let known = store.get(tabAtom)?.blockids ?? [];
    return store.sub(tabAtom, () => {
        // A tab not loaded yet says nothing about which blocks went; a loaded tab with no block has a null list.
        const tab = store.get(tabAtom);
        if (tab == null) {
            return;
        }
        const after = tab.blockids ?? [];
        const gone = goneBlockIds(known, after);
        known = after;
        for (const blockId of gone) {
            const node = layout.getNodeByBlockId(blockId);
            if (node != null) {
                layout.dropLeafNode(node.id);
            }
        }
    });
}
