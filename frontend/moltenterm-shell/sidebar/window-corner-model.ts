// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Spaces frame (DS-SHELL-127, #1216): one margin between the window's edges and the panels and between two panels,
// and with the sidebar hidden no top bar: the window buttons and the sidebar toggle show only while the pointer is in
// the top-left corner they sit in.

// The frame's one margin. workspace.tsx hands it to the panel layout as its gap and to the CSS as --mt-frame-gap, so
// the gap between panels can never drift from the window's margins (window:tilegapsize applies off the sidebar).
export const FrameGapPx = 8;

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
