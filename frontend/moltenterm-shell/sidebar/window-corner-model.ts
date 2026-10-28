// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Spaces frame (DS-SHELL-127, #1216): one margin between the window's edges and the panels and between two panels,
// and with the sidebar hidden no top bar: the window buttons and the sidebar toggle show only while the pointer is in
// the top-left corner they sit in.

// The frame's one margin when window:tilegapsize is not set.
export const FrameGapPx = 8;

export type FrameSizes = { marginPx: number; gapPx: number };

// window:tilegapsize drives the frame's one token: workspace.tsx hands it to the CSS as --mt-frame-gap (the window's
// margins) and to the panel layout as its gap, so a set value changes both and they never drift apart.
export function frameSizes(tileGapSetting: unknown): FrameSizes {
    const px =
        typeof tileGapSetting === "number" && Number.isFinite(tileGapSetting) && tileGapSetting >= 0
            ? tileGapSetting
            : FrameGapPx;
    return { marginPx: px, gapPx: px };
}

export type WindowButtonsState = {
    sidebarHidden: boolean;
    peek: boolean;
    corner: boolean;
    fullScreen: boolean;
};

// Full screen gives the buttons back to the system's own reveal, which a hidden state would leave empty.
export function windowButtonsVisible(state: WindowButtonsState): boolean {
    return !state.sidebarHidden || state.peek || state.corner || state.fullScreen;
}

// The corner is the box drawn at the window's top-left, so its right and bottom edges are its size.
export function pointerInCorner(x: number, y: number, corner: { right: number; bottom: number }): boolean {
    return x >= 0 && y >= 0 && x < corner.right && y < corner.bottom;
}
