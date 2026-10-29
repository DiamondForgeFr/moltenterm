// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    controlsOverlayHeight,
    frameSizes,
    MacButtonHeightPx,
    MacButtonsLeftPx,
    macButtonsPosition,
    peekButtonsInsetPx,
    PeekInsetPx,
    readWindowButtonsMessage,
    windowButtonsInPeek,
    windowButtonsVisible,
    windowRowCentrePt,
    windowRowHeightPt,
    WindowRowPx,
} from "./window-corner-model";

describe("the frame's one margin (DS-SHELL-127)", () => {
    it("is 8 px when window:tilegapsize is not set", () => {
        expect(frameSizes(undefined)).toEqual({ marginPx: 8, gapPx: 8 });
        expect(frameSizes(null)).toEqual({ marginPx: 8, gapPx: 8 });
    });

    it("takes a set window:tilegapsize for both the margins and the gap between panels", () => {
        expect(frameSizes(3)).toEqual({ marginPx: 3, gapPx: 3 });
        expect(frameSizes(12)).toEqual({ marginPx: 12, gapPx: 12 });
        expect(frameSizes(0)).toEqual({ marginPx: 0, gapPx: 0 });
    });

    it("ignores a value that is not a size", () => {
        expect(frameSizes(-4)).toEqual({ marginPx: 8, gapPx: 8 });
        expect(frameSizes("10")).toEqual({ marginPx: 8, gapPx: 8 });
        expect(frameSizes(Number.NaN)).toEqual({ marginPx: 8, gapPx: 8 });
    });
});

const hidden = { sidebarHidden: true, peek: false, fullScreen: false };

describe("the window buttons come and go with the sidebar (DS-SHELL-127, #1279)", () => {
    it("show with the sidebar", () => {
        expect(windowButtonsVisible({ ...hidden, sidebarHidden: false })).toBe(true);
    });

    it("hide with the sidebar, and come back when it peeks from the left edge", () => {
        expect(windowButtonsVisible(hidden)).toBe(false);
        expect(windowButtonsVisible({ ...hidden, peek: true })).toBe(true);
    });

    it("stay with the system in full screen", () => {
        expect(windowButtonsVisible({ ...hidden, fullScreen: true })).toBe(true);
    });
});

describe("the window row's centre line (#1279)", () => {
    it("is halfway between the window's top edge and the top field", () => {
        expect(windowRowHeightPt(1)).toBe(WindowRowPx);
        expect(windowRowCentrePt(1)).toBe(WindowRowPx / 2);
    });

    it("keeps the band in window points under 100 % and grows it with a larger zoom", () => {
        expect(windowRowHeightPt(0.8)).toBe(WindowRowPx);
        expect(windowRowHeightPt(1.5)).toBe(WindowRowPx * 1.5);
        expect(windowRowHeightPt(undefined)).toBe(WindowRowPx);
        expect(windowRowHeightPt(Number.NaN)).toBe(WindowRowPx);
        expect(windowRowHeightPt(-2)).toBe(WindowRowPx);
    });

    it("carries the system's window buttons, centred on it within a point", () => {
        for (const zoom of [0.7, 1, 1.25, 1.5, 2]) {
            const pos = macButtonsPosition(zoom);
            expect(pos.x).toBe(MacButtonsLeftPx);
            expect(Math.abs(pos.y + MacButtonHeightPx / 2 - windowRowCentrePt(zoom))).toBeLessThanOrEqual(0.5);
        }
    });

    it("sizes the window controls drawn over the page to the same band", () => {
        expect(controlsOverlayHeight(1)).toBe(WindowRowPx);
        expect(controlsOverlayHeight(1.25)).toBe(50);
    });
});

describe("the window buttons in the floating sidebar (DS-SHELL-127, #1293)", () => {
    it("has one 12 px inner margin", () => {
        expect(PeekInsetPx).toBe(12);
    });

    it("insets the buttons by the frame margin plus the inner margin from the window's top and left edges", () => {
        expect(peekButtonsInsetPx(8)).toBe(20);
        expect(peekButtonsInsetPx(0)).toBe(12);
        expect(peekButtonsInsetPx(16)).toBe(28);
        expect(peekButtonsInsetPx(undefined)).toBe(20);
        expect(macButtonsPosition(1, 8)).toEqual({ x: 20, y: 20 });
    });

    it("turns the panel's page pixels into window points with the zoom", () => {
        expect(macButtonsPosition(1.5, 8)).toEqual({ x: 30, y: 30 });
        expect(macButtonsPosition(0.8, 8)).toEqual({ x: 16, y: 16 });
        expect(macButtonsPosition(Number.NaN, 8)).toEqual({ x: 20, y: 20 });
    });

    it("leaves the docked position of #1279 alone", () => {
        expect(macButtonsPosition(1)).toEqual({ x: MacButtonsLeftPx, y: 12 });
        expect(macButtonsPosition(1, undefined)).toEqual(macButtonsPosition(1));
    });

    it("belong to the panel whenever the sidebar is hidden, peeked or not, except in full screen", () => {
        expect(windowButtonsInPeek(hidden)).toBe(true);
        expect(windowButtonsInPeek({ ...hidden, peek: true })).toBe(true);
        expect(windowButtonsInPeek({ ...hidden, sidebarHidden: false })).toBe(false);
        expect(windowButtonsInPeek({ ...hidden, fullScreen: true })).toBe(false);
    });
});

describe("the message the page sends about the window buttons", () => {
    it("reads the visibility and the zoom", () => {
        expect(readWindowButtonsMessage({ visible: true, zoom: 1.25 })).toEqual({ visible: true, zoom: 1.25 });
        expect(readWindowButtonsMessage({ visible: "yes", zoom: "2" })).toEqual({ visible: false, zoom: 1 });
    });

    it("reads the frame margin of the floating panel, a bad one as the default", () => {
        expect(readWindowButtonsMessage({ visible: true, zoom: 1, peekGap: 6 })).toEqual({
            visible: true,
            zoom: 1,
            peekGap: 6,
        });
        expect(readWindowButtonsMessage({ visible: true, zoom: 1, peekGap: -3 }).peekGap).toBe(8);
        expect(readWindowButtonsMessage({ visible: true, zoom: 1 })).not.toHaveProperty("peekGap");
    });

    it("asks for the window's defaults back when it is not an object", () => {
        expect(readWindowButtonsMessage(null)).toBeNull();
        expect(readWindowButtonsMessage(true)).toBeNull();
        expect(readWindowButtonsMessage("x")).toBeNull();
    });
});
