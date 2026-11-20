// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// When a panel's content is there (FR-SHELL-082, #2438): the one signal every panel kind gives, read by the frames a
// workspace switch draws (layout-frames.ts). A panel whose content is still to come carries this attribute on the
// element that waits: the suite's first-draw loader (a card or large domino), a browser page before its first load
// ends, a terminal before it has drawn anything. A frame keeps its domino while its panel holds one that is laid out.
// Kept free of imports: the suite and Wave's terminal load it at first paint.

export const PanelWaitingAttr = "data-df-waiting";

// A terminal that never draws anything (a shell that prints nothing) or a page that never stops loading stops waiting
// after this, so a kept view's panel never holds a frame on the next switch.
export const PanelWaitingMaxMs = 8000;

export function markPanelWaiting(el: Element) {
    el?.setAttribute(PanelWaitingAttr, "");
}

export function markPanelReady(el: Element) {
    el?.removeAttribute(PanelWaitingAttr);
}

// Only what is laid out counts: a part that is not displayed (a folded section, a closed tab) waits for nobody.
export function panelWaiting(block: Element): boolean {
    if (block == null) {
        return false;
    }
    for (const el of Array.from(block.querySelectorAll(`[${PanelWaitingAttr}]`))) {
        if (el.getClientRects().length > 0) {
            return true;
        }
    }
    return false;
}
