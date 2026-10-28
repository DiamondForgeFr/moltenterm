// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    controlsOverlayHeight,
    frameSizes,
    MacButtonHeightPx,
    MacButtonsLeftPx,
    macButtonsPosition,
    readWindowButtonsMessage,
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

describe("the message the page sends about the window buttons", () => {
    it("reads the visibility and the zoom", () => {
        expect(readWindowButtonsMessage({ visible: true, zoom: 1.25 })).toEqual({ visible: true, zoom: 1.25 });
        expect(readWindowButtonsMessage({ visible: "yes", zoom: "2" })).toEqual({ visible: false, zoom: 1 });
    });

    it("asks for the window's defaults back when it is not an object", () => {
        expect(readWindowButtonsMessage(null)).toBeNull();
        expect(readWindowButtonsMessage(true)).toBeNull();
        expect(readWindowButtonsMessage("x")).toBeNull();
    });
});
