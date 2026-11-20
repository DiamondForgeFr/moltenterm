// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    parseSnapshot,
    sidebarAtRest,
    snapshotFits,
    snapshotKey,
    staleSnapshotKeys,
    uncomposite,
} from "./sidebar-snapshot";

describe("the neighbour's captured sidebar (#1261, TC-SHELL-218)", () => {
    it("reads back only a well-formed image capture", () => {
        const raw = JSON.stringify({ url: "data:image/png;base64,AAA", width: 256, height: 1041, at: 5 });
        expect(parseSnapshot(raw)).toEqual({ url: "data:image/png;base64,AAA", width: 256, height: 1041, at: 5 });
        expect(parseSnapshot(JSON.stringify({ url: "https://example.com/x.png", width: 1, height: 1 }))).toBeNull();
        expect(parseSnapshot(JSON.stringify({ url: "data:image/png;base64,AAA", width: 0, height: 1 }))).toBeNull();
        expect(parseSnapshot("not json")).toBeNull();
        expect(parseSnapshot(null)).toBeNull();
    });

    it("is shown only when the sidebar kept its size, so the swipe lands on the same pixels", () => {
        const snap = { url: "data:image/png;base64,AAA", width: 256, height: 1041, at: 0 };
        expect(snapshotFits(snap, 256, 1041)).toBe(true);
        expect(snapshotFits(snap, 256.5, 1040.4)).toBe(true);
        expect(snapshotFits(snap, 300, 1041)).toBe(false);
        expect(snapshotFits(null, 256, 1041)).toBe(false);
    });

    it("drops the captures of workspaces that no longer exist, and nothing else", () => {
        const keys = [snapshotKey("a"), snapshotKey("b"), "moltenterm:sidebar-switch", "other"];
        expect(staleSnapshotKeys(keys, ["a"])).toEqual([snapshotKey("b")]);
    });

    it("never captures while the library covers the sidebar (#1392)", () => {
        const rest = { hidden: false, pageOver: false, libraryOpen: false, swiping: false, animating: false };
        expect(sidebarAtRest(rest)).toBe(true);
        expect(sidebarAtRest({ ...rest, libraryOpen: true })).toBe(false);
        expect(sidebarAtRest({ ...rest, pageOver: true })).toBe(false);
        expect(sidebarAtRest({ ...rest, swiping: true })).toBe(false);
    });
});

// Straight-alpha "source over", in 8-bit channels, as the compositor draws one layer over another.
function over(src: number[], dst: number[]): number[] {
    const as = src[3] / 255;
    const ad = dst[3] / 255;
    const a = as + ad * (1 - as);
    if (a <= 0) {
        return [0, 0, 0, 0];
    }
    const rgb = [0, 1, 2].map((c) => Math.round(((src[c] / 255) * as + (dst[c] / 255) * ad * (1 - as)) / a * 255));
    return [...rgb, Math.round(a * 255)];
}

describe("the neighbour's sidebar without the window's material (#2407)", () => {
    // The frame's tint at a see-through look's alpha, and some of the sidebar's own pixels: text, a tile, nothing.
    const Material = [32, 30, 28, Math.round(0.72 * 255)];
    const Content = [
        [240, 238, 232, 255],
        [255, 255, 255, 23],
        [0, 0, 0, 0],
        [200, 90, 40, 180],
    ];

    it("gives back the content alone, which drawn over the same material is the pixel the view showed", () => {
        for (const c of Content) {
            const shown = over(c, Material);
            const pixels = new Uint8ClampedArray(shown);
            uncomposite(pixels, new Uint8ClampedArray(Material));
            const again = over(Array.from(pixels), Material);
            for (let ch = 0; ch < 4; ch++) {
                expect(Math.abs(again[ch] - shown[ch])).toBeLessThanOrEqual(2);
            }
        }
    });

    it("is why the incoming sidebar no longer comes in darker: the capture over the material counted it twice", () => {
        const shown = over(Content[2], Material);
        const twice = over(shown, Material);
        expect(twice[3]).toBeGreaterThan(shown[3]);
        const pixels = new Uint8ClampedArray(shown);
        uncomposite(pixels, new Uint8ClampedArray(Material));
        expect(over(Array.from(pixels), Material)).toEqual(shown);
    });

    it("leaves a pixel alone where the material is opaque: over an opaque frame it is already itself", () => {
        const pixels = new Uint8ClampedArray([10, 20, 30, 255]);
        uncomposite(pixels, new Uint8ClampedArray([1, 2, 3, 255]));
        expect(Array.from(pixels)).toEqual([10, 20, 30, 255]);
    });
});
