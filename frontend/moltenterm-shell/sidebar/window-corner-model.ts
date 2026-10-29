// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Spaces frame (DS-SHELL-127, #1216): one margin between the window's edges and the panels and between two panels,
// and with the sidebar hidden no top bar: the window buttons show only with the sidebar (#1279).

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

// The window row (#1279): the band from the window's top edge to the top field's top edge. The window buttons, the
// sidebar toggle and the row's other icons all centre on its half, as Arc's do. Electron main reads the same numbers
// to place the system's window buttons, so the row and the buttons cannot drift apart.
export const WindowRowPx = 40;
// The system draws each window button in a frame this tall; Electron centres the buttons on y + this half.
export const MacButtonHeightPx = 16;
// The first window button's distance from the window's left edge, as the room left for them assumes.
export const MacButtonsLeftPx = 12;
// The window controls' own height on the platforms that draw them over the page (top right), when nothing sets it.
export const DefaultControlsOverlayPx = 32;
// The floating sidebar's one inner margin (#1293), as Arc's: on its four sides, the window buttons inset by it from
// the panel's top and left edges, and one more of it between the buttons and the top field.
export const PeekInsetPx = 12;

function validZoom(zoom: unknown): number {
    return typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

// The band in window points. The page draws it as max(40px, 40px / zoom): never under 40 points, and growing with a
// zoom above 100 % so the row's 28 px hit areas still fit.
export function windowRowHeightPt(zoom: unknown): number {
    return WindowRowPx * Math.max(1, validZoom(zoom));
}

export function windowRowCentrePt(zoom: unknown): number {
    return windowRowHeightPt(zoom) / 2;
}

// Where Electron places the system's window buttons (setWindowButtonPosition). Docked: their centre on the row's centre
// line. With the sidebar hidden (peekGap set, the frame margin in page pixels): inside the floating panel, which sits
// one frame margin from the window's top and left edges, one inner margin from its top and left edges. The page's
// pixels are window points times the zoom; the buttons' own size is not.
export function macButtonsPosition(zoom: unknown, peekGap?: number): { x: number; y: number } {
    if (peekGap != null) {
        const inset = Math.round(peekButtonsInsetPx(peekGap) * validZoom(zoom));
        return { x: inset, y: inset };
    }
    return { x: MacButtonsLeftPx, y: Math.round(windowRowCentrePt(zoom) - MacButtonHeightPx / 2) };
}

// The window buttons' distance from the window's top and left edges in the floating panel, in page pixels.
export function peekButtonsInsetPx(peekGap: unknown): number {
    return frameSizes(peekGap).marginPx + PeekInsetPx;
}

// The window controls drawn over the page on the right take the row's height, so they share its centre line.
export function controlsOverlayHeight(zoom: unknown): number {
    return Math.round(windowRowHeightPt(zoom));
}

export type WindowButtonsState = {
    sidebarHidden: boolean;
    peek: boolean;
    fullScreen: boolean;
};

// The buttons come and go with the sidebar (#1279): shown, or peeked from the left edge. Full screen gives them back
// to the system's own reveal, which a hidden state would leave empty.
export function windowButtonsVisible(state: WindowButtonsState): boolean {
    return !state.sidebarHidden || state.peek || state.fullScreen;
}

// The buttons sit inside the floating panel whenever the sidebar is hidden, peeked or not, so they never jump when the
// panel slides in. Full screen leaves them to the system.
export function windowButtonsInPeek(state: WindowButtonsState): boolean {
    return state.sidebarHidden && !state.fullScreen;
}

// peekGap: the frame margin, sent only while the buttons belong to the floating panel.
export type WindowButtonsMessage = { visible: boolean; zoom: number; peekGap?: number };

// What the page sends to Electron main; null (or anything else) puts the window's own defaults back.
export function readWindowButtonsMessage(value: unknown): WindowButtonsMessage | null {
    if (value == null || typeof value !== "object") {
        return null;
    }
    const msg = value as Record<string, unknown>;
    const read: WindowButtonsMessage = { visible: msg.visible === true, zoom: validZoom(msg.zoom) };
    if (msg.peekGap != null) {
        read.peekGap = frameSizes(msg.peekGap).marginPx;
    }
    return read;
}
