// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RibbonShapes } from "./ribbon-shapes";
import { DrawAnotherButton, ShapeGrid } from "./shape-picker";

function picker(value = "moon") {
    return renderToStaticMarkup(<ShapeGrid value={value} paint="#58c142" onChange={() => {}} />);
}

describe("the ribbon shape picker (FR-SHELL-159)", () => {
    it("offers the fifteen shapes as one radio group", () => {
        const html = picker();
        expect(html).toContain('role="radiogroup"');
        expect(html.match(/role="radio"/g)).toHaveLength(15);
        for (const shape of RibbonShapes) {
            expect(html).toContain(`data-shape="${shape.id}"`);
        }
    });

    it("draws each shape in the context's colour and with its own cut", () => {
        const html = picker();
        expect(html.match(/--ribbon-paint:#58c142/g)).toHaveLength(15);
        const clips = [...html.matchAll(/--ribbon-clip:([^;"]*)/g)].map((m) => m[1]);
        expect(new Set(clips).size).toBe(15);
    });

    it("checks the chosen shape and gives the group a single tab stop", () => {
        const html = picker("blade");
        expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
        expect(html).toMatch(/aria-checked="true"[^>]*data-shape="blade"/);
        expect(html.match(/tabindex="0"/g)).toHaveLength(1);
        expect(html.match(/tabindex="-1"/g)).toHaveLength(14);
    });

    it("names every shape to a screen reader", () => {
        const html = picker();
        for (const shape of RibbonShapes) {
            expect(html).toMatch(new RegExp(`aria-label="[^"]+"[^>]*data-shape="${shape.id}"`));
        }
    });

    it("has a button to draw another shape", () => {
        const html = renderToStaticMarkup(<DrawAnotherButton onDrawAnother={() => {}} />);
        expect(html).toContain('data-testid="shape-draw-another"');
        expect(html).toContain(">Draw another<");
    });
});
