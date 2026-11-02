// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Closing a panel of the carpet under a 360 × N (FR-SHELL-126-AC3): the neighbour tab takes the freed place, so N
// places stay visible while panels are stored. Kept apart from the model so the rule is tested alone.

// The stored column that fills the place of the closed one: the next stored column to the right of the places in view,
// else the one to their left. Null when nothing is stored.
export function closeReplacement(columnIds: string[], visibleIds: string[]): string {
    const visible = (columnIds ?? []).filter((id) => visibleIds?.includes(id));
    if (!visible.length) {
        return null;
    }
    const right = columnIds[columnIds.indexOf(visible[visible.length - 1]) + 1];
    if (right != null) {
        return right;
    }
    return columnIds[columnIds.indexOf(visible[0]) - 1] ?? null;
}

// The column that must be the first one in view once closedId is gone: the places in view without it, plus the
// replacement when it was one of them. A column closed out of view leaves the places as they are. Null when no column
// is left in view.
export function closeAnchorColumn(columnIds: string[], visibleIds: string[], closedId: string): string {
    if (!columnIds?.includes(closedId)) {
        return null;
    }
    const visible = columnIds.filter((id) => visibleIds?.includes(id));
    if (!visible.includes(closedId)) {
        return visible[0] ?? null;
    }
    const replacement = closeReplacement(columnIds, visibleIds);
    const after = visible.filter((id) => id !== closedId);
    if (replacement != null) {
        after.push(replacement);
    }
    after.sort((a, b) => columnIds.indexOf(a) - columnIds.indexOf(b));
    return after[0] ?? null;
}
