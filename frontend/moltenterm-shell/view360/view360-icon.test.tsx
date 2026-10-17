// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CarpetIcon } from "./view360-icon";

function attr(html: string, part: string, name: string): number {
    const tag = html.match(new RegExp(`<[^>]*data-part="${part}"[^>]*>`))?.[0] ?? "";
    return Number(tag.match(new RegExp(`\\s${name}="([^"]+)"`))?.[1]);
}

describe("CarpetIcon (#824)", () => {
    const html = renderToStaticMarkup(<CarpetIcon />);

    it("keeps the toggle's 14×12 box, decorative, in the text colour", () => {
        expect(html).toContain('width="14"');
        expect(html).toContain('height="12"');
        expect(html).toContain('aria-hidden="true"');
        expect(html).not.toMatch(/fill="#|stroke="#/);
    });

    it("draws a solid fixed column, narrower than the outlined panel, so it never reads as a pause button", () => {
        expect(html).toMatch(/data-part="fixed"[^>]*fill="currentColor"/);
        expect(attr(html, "fixed", "width")).toBeLessThan(attr(html, "panel", "width"));
        expect(attr(html, "fixed", "height")).toBeGreaterThan(attr(html, "panel", "height"));
    });

    it("carries a two-way arrow under the panel for the sideways scroll", () => {
        const d = html.match(/data-part="scroll"[^>]*d="([^"]+)"/)?.[1] ?? "";
        expect(d.split("M")).toHaveLength(4);
        expect(attr(html, "panel", "y") + attr(html, "panel", "height")).toBeLessThan(9);
    });
});
