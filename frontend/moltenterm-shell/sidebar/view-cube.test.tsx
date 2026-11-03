// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The 360 cube in a view's icon (FR-SHELL-081, #1823): what each place that draws a view's icon renders, and that it
// never rotates under reduced motion.

import { readFileSync } from "fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ViewCube } from "./view-cube";
import { ViewGlyph } from "./view-glyph";
import type { GlyphCube } from "./view-menu-model";

const page: GlyphCube = { cube: true, id: "page", icon: "globe", index: 1, count: 2 };

function faces(html: string): { slot: string; role: string; icon: string }[] {
    return [
        ...html.matchAll(/<span class="mt-cube-face" data-slot="(\d)" data-role="(\w+)"[^>]*><i class="([^"]*)"/g),
    ].map((m) => ({ slot: m[1], role: m[2], icon: m[3] }));
}

describe("ViewCube", () => {
    const html = renderToStaticMarkup(<ViewCube cube={page} />);

    it("rests with the carpet panel's icon on the front face and the neighbours around it", () => {
        const all = faces(html);
        expect(all).toHaveLength(4);
        expect(all.find((f) => f.role === "front").icon).toContain("fa-globe");
        expect(all.map((f) => f.role).sort()).toEqual(["back", "front", "left", "right"]);
        expect(html).toContain("--mt-cube-turn:0deg");
        expect(html).toContain('data-front="page"');
        expect(html).toContain('data-count="2"');
    });

    it("has a lit top face and no content of its own", () => {
        expect(html).toContain('<span class="mt-cube-face is-top"></span>');
    });

    it("is decorative: its glyph is hidden from assistive technology by the glyph that holds it", () => {
        const glyph = renderToStaticMarkup(<ViewGlyph icons={["robot", page]} />);
        expect(glyph).toContain('aria-hidden="true"');
        expect(glyph).toContain('data-testid="sidebar-glyph"');
    });

    it("takes the small size in a view row", () => {
        expect(renderToStaticMarkup(<ViewCube cube={page} small />)).toContain('class="mt-cube is-small"');
        expect(html).toContain('class="mt-cube"');
    });
});

describe("ViewGlyph with the carpet (#1823)", () => {
    it("draws a grid view as before: one icon per panel, parted by a slash, no cube", () => {
        const html = renderToStaticMarkup(<ViewGlyph icons={["robot", "globe"]} />);
        expect(html.match(/<i class=/g)).toHaveLength(2);
        expect(html.match(/data-sl="1"/g)).toHaveLength(1);
        expect(html).not.toContain("mt-cube");
    });

    it("draws a 360 view as the fixed panel's icon, a slash and one cube", () => {
        const html = renderToStaticMarkup(<ViewGlyph icons={["robot", page]} small />);
        expect(html.match(/class="mt-cube is-small"/g)).toHaveLength(1);
        expect(html.match(/data-sl="1"/g)).toHaveLength(1);
        expect(html.indexOf("fa-robot")).toBeLessThan(html.indexOf("mt-cube"));
    });
});

describe("view-cube.css (#1823)", () => {
    const css = readFileSync(`${__dirname}/view-cube.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const tokens = readFileSync(`${__dirname}/../tokens.css`, "utf8");

    it("turns in about 300 ms, from a token that is zero under reduced motion", () => {
        expect(tokens).toContain("--mt-duration-cube: 300ms;");
        expect(tokens.match(/--mt-duration-cube: 0ms;/g)).toHaveLength(2);
        expect(css).toContain("transition: transform var(--mt-duration-cube");
    });

    it("never transitions under the system preference or MoltenTerm's own setting", () => {
        const media = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
        expect(media).toMatch(/\.mt-cube-body,[\s\S]*?transition: none/);
        expect(css).toMatch(/\.prefers-reduced-motion \.mt-cube-body,[\s\S]*?transition: none/);
    });

    it("keeps the front face flat: no perspective, so nothing scales or blurs at rest", () => {
        expect(css).not.toMatch(/perspective/);
        expect(css).toContain("matrix3d(");
    });

    it("carries no accent colour: orange stays for actions", () => {
        expect(css).not.toMatch(/accent|orange|#[0-9a-f]{3,6}\b/i);
    });
});
