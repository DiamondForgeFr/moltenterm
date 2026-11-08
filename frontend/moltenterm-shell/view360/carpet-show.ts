// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Shows a panel the developer asked to go to (#1992): the panel is focused, and on the 360 carpet the carpet glides so
// that its column is fully in view (revealPanelOnCarpet, #747). A download's "Go to the page" is the first caller;
// #1994 (agents bring a page into view) shares it, so both reach a panel the same way. Outside 360 view the reveal does
// nothing and the panel simply has the focus.

import { getLayoutModelForStaticTab } from "@/layout/lib/layoutModelHooks";
import { showPanel } from "../hidden-panel";
import { revealPanelOnCarpet } from "./carpet-reveal";

// The carpet may not have its layout yet when a view has just been shown: the reveal is tried again a few times.
export const RevealRetryMs = 100;
export const RevealMaxTries = 10;

export type ShowInViewDeps = {
    showPanel: (blockId: string) => boolean;
    reveal: (blockId: string) => void;
    // Whether the 360 layout is drawn: false outside 360 view (nothing to reveal) and before its first pass.
    carpetReady: () => boolean;
    later: (fn: () => void, ms: number) => void;
};

const realDeps: ShowInViewDeps = {
    showPanel: (blockId) => showPanel(blockId),
    reveal: revealPanelOnCarpet,
    carpetReady: () => getLayoutModelForStaticTab()?.moltenView360?.layout != null,
    later: (fn, ms) => {
        setTimeout(fn, ms);
    },
};

// Returns whether the panel is laid out and was focused; false when it is not (the caller tries again, as a tab
// just shown may not have its layout yet).
export function showPanelInView(blockId: string, deps: ShowInViewDeps = realDeps): boolean {
    if (!deps.showPanel(blockId)) {
        return false;
    }
    let tries = 0;
    const reveal = () => {
        if (deps.carpetReady()) {
            deps.reveal(blockId);
            return;
        }
        if (++tries < RevealMaxTries) {
            deps.later(reveal, RevealRetryMs);
        }
    };
    reveal();
    return true;
}
