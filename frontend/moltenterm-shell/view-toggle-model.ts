// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The rail's toggle rule (#533, #534), apart from the store so it is tested without a window.

export type ToggleStep = "open" | "close" | "replace";

// A view open in the tab closes; the last pane of a tab gives way to a terminal, since closing it would close the tab.
export function toggleStep(openBlockId: string, tabBlockCount: number): ToggleStep {
    if (!openBlockId) {
        return "open";
    }
    return tabBlockCount <= 1 ? "replace" : "close";
}
