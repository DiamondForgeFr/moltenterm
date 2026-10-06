// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A link clicked inside a block hands the focus to a browser panel (#268). Wave's block click handler gives the focus
// back to the block that was clicked, so the two blocks would trade it forever (React error 185). While a hand-off is
// in progress the block handlers leave the focus alone. The click reaches the block right after the link's handler
// returns, and the panel takes the focus some frames later, so the hand-off outlives the open itself.

export const FocusHandoffSettleMs = 400;

let activeHandoffs = 0;

export function focusHandoffActive(): boolean {
    return activeHandoffs > 0;
}

export async function withFocusHandoff<T>(open: () => Promise<T>): Promise<T> {
    activeHandoffs++;
    try {
        return await open();
    } finally {
        setTimeout(() => {
            activeHandoffs--;
        }, FocusHandoffSettleMs);
    }
}
