// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The tether of a rail panel (FR-BOSS-009, AC65 to AC69, #2196): the rope that ties a panel to its button, and the thread
// that ties Brokk's square to his title-bar face. This is its geometry, pure, so that it is tested without a window; the
// markup is tether.tsx's and the motion tether.css's.
//
// The rope lies from the button's edge to the panel's edge. While the panel comes out it is `slide` px back from where it
// settles, and the rope is exactly as long as the distance between the two edges, so the far end rides on the panel's
// edge at every moment of the slide: the style sheet scales the rope from `from` to 1 with the duration and the curve of
// the panel's slide.

export const RopePx = 2;
export const AnchorPx = 6;
export const KnotPx = 4;
// The rope keeps this far from the panel's top and bottom, on the straight part of its edge.
export const AttachMarginPx = 12;

export type TetherLine = {
    // Where the rope is tied, on the button's edge, in the parent's coordinates.
    left: number;
    // The rope's top edge; its middle is RopePx / 2 lower.
    top: number;
    // From the anchor to the panel's edge once the panel is in place.
    width: number;
    // The part of the width that is out while the panel is `slide` px back, from 0 to 1.
    from: number;
};

export function tetherLine(tiedAt: number, settledAt: number, middle: number, slide = 0): TetherLine {
    const width = Math.max(0, settledAt - tiedAt);
    const from = width > 0 ? Math.min(1, Math.max(0, (width - slide) / width)) : 0;
    return { left: tiedAt, top: middle - RopePx / 2, width, from };
}

// A window too short for the panel to reach the button's level holds the rope on the panel's edge instead of in the air.
export function attachMiddle(middle: number, panelHeight: number): number {
    if (panelHeight <= 2 * AttachMarginPx) {
        return panelHeight / 2;
    }
    return Math.min(Math.max(middle, AttachMarginPx), panelHeight - AttachMarginPx);
}

// Where the rope's far end stands when the slide has run `progress` of its way (0 closed, 1 settled, a little past 1 while
// the curve gives).
export function farEnd(line: TetherLine, progress: number): number {
    return line.left + line.width * (line.from + (1 - line.from) * progress);
}
