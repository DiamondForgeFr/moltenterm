// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A panel created to be used at once (a page opened beside, #1187) takes the focus once the layout has placed it: the
// created block's "focused" flag comes before its node exists, and the page it was opened from keeps the focus otherwise.

import { refocusNode } from "@/app/store/global";
import { getLayoutModelForStaticTab } from "@/layout/index";

const PlacedPollMs = 50;
const PlacedWaitMs = 5000;

export function focusWhenPlaced(blockId: string): void {
    if (!blockId) {
        return;
    }
    const deadline = Date.now() + PlacedWaitMs;
    const attempt = () => {
        if (getLayoutModelForStaticTab()?.getNodeByBlockId(blockId) != null) {
            refocusNode(blockId);
            return;
        }
        if (Date.now() < deadline) {
            setTimeout(attempt, PlacedPollMs);
        }
    };
    attempt();
}

export function blockIdOfORef(oref: string): string {
    const at = (oref ?? "").indexOf(":");
    return at >= 0 ? oref.slice(at + 1) : null;
}
