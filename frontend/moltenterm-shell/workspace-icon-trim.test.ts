// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { contentBox, ContentShare, trimLayout } from "./workspace-icon-trim";

// An RGBA image of w x h, transparent, with an opaque rectangle.
function image(w: number, h: number, rect: { x: number; y: number; w: number; h: number }, alpha = 255) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = rect.y; y < rect.y + rect.h; y++) {
        for (let x = rect.x; x < rect.x + rect.w; x++) {
            data[(y * w + x) * 4 + 3] = alpha;
        }
    }
    return data;
}

describe("workspace icon trim", () => {
    it("finds the visible content inside a transparent margin", () => {
        expect(contentBox(image(100, 100, { x: 30, y: 40, w: 20, h: 10 }), 100, 100)).toEqual({
            x: 30,
            y: 40,
            w: 20,
            h: 10,
            transparent: true,
        });
        expect(contentBox(image(10, 10, { x: 0, y: 0, w: 0, h: 0 }), 10, 10)).toBeNull();
        expect(contentBox(image(10, 10, { x: 2, y: 2, w: 3, h: 3 }, 8), 10, 10)).toBeNull();
    });

    it("an opaque image is only made square, a transparent one gets the same padding", () => {
        const opaque = contentBox(image(40, 20, { x: 0, y: 0, w: 40, h: 20 }), 40, 20);
        expect(opaque.transparent).toBe(false);
        expect(trimLayout(opaque)).toEqual({ side: 40, dx: 0, dy: 10, dw: 40, dh: 20 });

        const small = trimLayout({ x: 30, y: 30, w: 20, h: 20, transparent: true });
        const large = trimLayout({ x: 0, y: 0, w: 86, h: 86, transparent: true });
        // The content fills the same share of the square, whatever margin the file had.
        expect(small.dw / small.side).toBeCloseTo(ContentShare);
        expect(large.dw / large.side).toBeCloseTo(ContentShare);

        const wide = trimLayout({ x: 0, y: 0, w: 120, h: 30, transparent: true });
        expect(wide.side).toBe(128);
        expect(wide.dw).toBeCloseTo(128 * ContentShare);
        expect(wide.dy + wide.dh / 2).toBeCloseTo(64);
    });
});
