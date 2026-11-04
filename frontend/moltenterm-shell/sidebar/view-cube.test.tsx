// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The 360 cube in a view's icon (FR-SHELL-081, #1823, #1861): what each place that draws a view's icon renders, the
// prism for several panels on screen, and that nothing moves under reduced motion.

import { readFileSync } from "fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ViewCube } from "./view-cube";
import { ViewGlyph } from "./view-glyph";
import type { GlyphCube } from "./view-menu-model";

const Panels = [
    { id: "companion", icon: "gauge" },
    { id: "page", icon: "globe" },
    { id: "term", icon: "terminal" },
    { id: "files", icon: "file-lines" },
    { id: "review", icon: "code-pull-request" },
];

function cubeOf(first: string, shown = 1): GlyphCube {
    const index = Panels.findIndex((p) => p.id === first);
    return { cube: true, id: first, icon: Panels[index].icon, index, count: Panels.length, shown, panels: Panels };
}

const page = cubeOf("page");

function faces(html: string): { slot: string; role: string; html: string }[] {
    return html
        .split('<span class="mt-cube-face" data-slot="')
        .slice(1)
        .map((chunk) => {
            const head = /^(\d)" data-role="(\w+)"/.exec(chunk);
            const end = chunk.indexOf('<span class="mt-cube-face');
            return { slot: head[1], role: head[2], html: end === -1 ? chunk : chunk.slice(0, end) };
        });
}

function icons(face: string): string[] {
    return [...face.matchAll(/<i class="([^"]*)"/g)].map((m) => m[1]);
}

describe("ViewCube", () => {
    const html = renderToStaticMarkup(<ViewCube cube={page} />);

    it("rests with the carpet panel's icon on the front face and the neighbours around it", () => {
        const all = faces(html);
        expect(all).toHaveLength(4);
        expect(all.map((f) => f.role).sort()).toEqual(["back", "front", "left", "right"]);
        expect(html).toContain("--mt-cube-turn:0deg");
        expect(html).toContain('data-front="page"');
        expect(html).toContain('data-count="5"');
        expect(html).toContain('data-cells="1"');
        expect(html).toContain('data-motion="none"');
    });

    it("holds the carpet's icons in order on every face, the belt the front face slides along", () => {
        for (const face of faces(html)) {
            expect(icons(face.html)).toEqual([
                expect.stringContaining("fa-gauge"),
                expect.stringContaining("fa-globe"),
                expect.stringContaining("fa-terminal"),
                expect.stringContaining("fa-file-lines"),
                expect.stringContaining("fa-code-pull-request"),
            ]);
            expect(face.html).toContain('style="--mt-cube-first:1"');
        }
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

describe("ViewCube as a prism of the panels on screen (#1861)", () => {
    it("is a cube for one panel: one cell, no count", () => {
        const html = renderToStaticMarkup(<ViewCube cube={cubeOf("page", 1)} />);
        expect(html).toContain("--cube-n:1");
        expect(html).not.toContain("view-cube-more");
    });

    it("is a 2:1 prism for two: two cells starting at the first panel on screen", () => {
        const html = renderToStaticMarkup(<ViewCube cube={cubeOf("page", 2)} />);
        expect(html).toContain("--cube-n:2");
        expect(html).toContain('data-cells="2"');
        expect(html).toContain('data-shown="2"');
        expect(html).toContain('style="--mt-cube-first:1"');
        expect(html).not.toContain("view-cube-more");
    });

    it("is a prism of three icons for three", () => {
        const html = renderToStaticMarkup(<ViewCube cube={cubeOf("companion", 3)} />);
        expect(html).toContain("--cube-n:3");
        expect(html).toContain('data-shown="3"');
        expect(html).not.toContain("view-cube-more");
    });

    it("draws three icons and +1 for four panels on screen, +2 for five", () => {
        const four = renderToStaticMarkup(<ViewCube cube={cubeOf("companion", 4)} />);
        expect(four).toContain("--cube-n:3");
        expect(four).toContain('data-shown="4"');
        expect(four).toMatch(/<span class="mt-cube-more" data-testid="view-cube-more">\+1<\/span>/);
        const five = renderToStaticMarkup(<ViewCube cube={cubeOf("companion", 5)} />);
        expect(five).toMatch(/data-testid="view-cube-more">\+2<\/span>/);
    });

    it("keeps the +N out of the cube's body, after it", () => {
        const html = renderToStaticMarkup(<ViewCube cube={cubeOf("companion", 4)} />);
        expect(html.indexOf("mt-cube-more")).toBeGreaterThan(html.lastIndexOf("mt-cube-face is-top"));
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

    it("draws a prism the same way wherever the glyph is drawn", () => {
        const html = renderToStaticMarkup(<ViewGlyph icons={["robot", cubeOf("page", 2)]} small />);
        expect(html.match(/class="mt-cube is-small"/g)).toHaveLength(1);
        expect(html).toContain('data-cells="2"');
    });
});

describe("view-cube.css (#1823, #1861)", () => {
    const css = readFileSync(`${__dirname}/view-cube.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const tokens = readFileSync(`${__dirname}/../tokens.css`, "utf8");

    it("turns in about 300 ms, from a token that is zero under reduced motion", () => {
        expect(tokens).toContain("--mt-duration-cube: 300ms;");
        expect(tokens.match(/--mt-duration-cube: 0ms;/g)).toHaveLength(2);
        expect(css).toContain("transition: transform var(--mt-duration-cube");
    });

    it("never transitions under the system preference or MoltenTerm's own setting", () => {
        const media = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
        for (const selector of [
            ".mt-cube",
            ".mt-cube-body",
            ".mt-cube-belt",
            '.mt-cube[data-motion="slide"] .mt-cube-belt',
        ]) {
            expect(media).toContain(`${selector},`);
        }
        expect(media).toMatch(/transition: none/);
        expect(css).toMatch(
            /\.prefers-reduced-motion \.mt-cube,[\s\S]*?\.prefers-reduced-motion \.mt-cube-body,[\s\S]*?transition: none/
        );
        expect(css).toMatch(/\.prefers-reduced-motion \.mt-cube-belt,[\s\S]*?transition: none/);
    });

    it("slides the belt only for a slide and a stretch, never for a turn or a plain change", () => {
        expect(css).toMatch(/\.mt-cube-belt \{[^}]*\n {4}top: 0;(?![^}]*transition)/);
        expect(css).toMatch(
            /\.mt-cube\[data-motion="slide"\] \.mt-cube-belt,\s*\.mt-cube\[data-motion="stretch"\] \.mt-cube-belt \{\s*transition: transform var\(--mt-duration-cube/
        );
    });

    it("draws the rules between the cells on the face in front only, like the icons", () => {
        expect(css).toMatch(/\.mt-cube-face\[data-role="front"\] \.mt-cube-rules \{\s*opacity: 1;/);
        expect(css).toMatch(/\.mt-cube-rules \{[^}]*opacity: 0;/);
    });

    it("stretches by animating the number of cells, a registered number", () => {
        expect(css).toMatch(/@property --cube-n \{[^}]*syntax: "<number>"/);
        expect(css).toMatch(/transition: --cube-n var\(--mt-duration-cube/);
    });

    it("is about 20 px tall, 18 px in a row: a 16 px (14 px) face and 4 px of depth", () => {
        expect(css).toMatch(/\.mt-cube \{[^}]*--cube-s: 16px;[^}]*--cube-cell: 16px;[^}]*--cube-d: 4px;/);
        expect(css).toMatch(/\.mt-cube\.is-small \{[^}]*--cube-s: 14px;[^}]*--cube-cell: 14px;/);
        expect(css).toContain("height: calc(var(--cube-s) + var(--cube-d))");
    });

    it("keeps the front face flat: no perspective, so nothing scales or blurs at rest", () => {
        expect(css).not.toMatch(/perspective/);
        expect(css).toContain("matrix3d(");
    });

    it("carries no accent colour: orange stays for actions", () => {
        expect(css).not.toMatch(/accent|orange|#[0-9a-f]{3,6}\b/i);
    });
});
