// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { setTransform } from "@/layout/lib/utils";

// Read from disk: vitest stubs stylesheet imports, ?raw included.
const shellCss = readFileSync(new URL("../moltenterm-shell.css", import.meta.url), "utf8");

function edges(top: number, height: number): [number, number] {
    const t = setTransform({ top, left: 0, width: 10, height });
    const y = Number(/translate3d\([^,]+,\s*([-\d.]+)px/.exec(t.transform as string)[1]);
    return [y, y + parseFloat(t.height as string)];
}

describe("panel edges (DS-SHELL-127, #1220)", () => {
    it("gives neighbouring tiles the same pixel edge, whatever the split", () => {
        for (const count of [2, 3, 6, 7]) {
            for (const total of [1192, 1191.5, 997, 640.33]) {
                const size = total / count;
                let previousBottom: number = null;
                for (let i = 0; i < count; i++) {
                    const [top, bottom] = edges(4 + i * size, size);
                    if (previousBottom != null) {
                        expect(top, `${count} tiles in ${total} px, tile ${i}`).toBe(previousBottom);
                    }
                    previousBottom = bottom;
                }
            }
        }
    });

    it("keeps integer sizes as they are", () => {
        expect(edges(8, 390)).toEqual([8, 398]);
    });

    it("leaves every default frame's mask without a border, focused or not", () => {
        const widths = [...shellCss.matchAll(/\.block-mask[^{]*\{[^}]*border-width:\s*([^;!]+)/g)].map((m) => m[1].trim());
        expect(widths.length).toBeGreaterThan(0);
        expect(new Set(widths)).toEqual(new Set(["0"]));
    });

    it("draws one 1 px inset edge on every panel, focus changing only its colour", () => {
        const shadows = [...shellCss.matchAll(/\.block-mask[^{]*\{[^}]*box-shadow:([^;]+);/g)].map((m) => m[1]);
        expect(shadows.length).toBe(2);
        for (const shadow of shadows) {
            const layers = shadow.split(/,\s*(?=inset)/).map((l) => l.trim());
            expect(layers[0]).toMatch(/^inset 0 0 0 1px /);
            for (const layer of layers) {
                expect(layer.startsWith("inset ")).toBe(true);
            }
        }
        expect(shellCss).not.toMatch(/\.block-mask[^{]*\{[^}]*outline:/);
    });
});
