// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The provider mark in a slot (#2542): the provider's own files, one for each theme when the provider has two, nothing
// for an agent without a mark, and a stylesheet that shows the file that reads on the theme.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { hasProviderMark, ProviderMark } from "./provider-mark";
import { ProviderMarks } from "./provider-marks";

const Css = readFileSync(join(__dirname, "provider-mark.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const html = (agent: string, slot = 17) => renderToStaticMarkup(<ProviderMark agent={agent} slot={slot} />);
const imgs = (markup: string) => [...markup.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
// The markup escapes what an attribute holds: a file the build inlines as a data address carries quotes.
const attr = (tag: string, name: string) =>
    new RegExp(`${name}="([^"]*)"`)
        .exec(tag)?.[1]
        ?.replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");

describe("the mark of an agent that has one", () => {
    it("draws the provider's file for each theme when the provider has two variants", () => {
        const tags = imgs(html("codex"));
        expect(tags).toHaveLength(2);
        expect(tags.map((tag) => attr(tag, "data-tone"))).toEqual(["on-dark", "on-light"]);
        expect(tags.map((tag) => attr(tag, "src"))).toEqual([ProviderMarks.codex.onDark, ProviderMarks.codex.onLight]);
        expect(ProviderMarks.codex.onDark).not.toBe(ProviderMarks.codex.onLight);
    });

    it("draws one file, for both themes, when the mark is in colour", () => {
        const tags = imgs(html("claude"));
        expect(tags).toHaveLength(1);
        expect(attr(tags[0], "data-tone")).toBeUndefined();
        expect(attr(tags[0], "src")).toBe(ProviderMarks.claude.onDark);
    });

    it("is decoration: the surface names the agent", () => {
        const markup = html("cursor");
        expect(markup).toMatch(/^<span [^>]*aria-hidden="true"/);
        expect(markup).toContain('data-mark="cursor"');
        for (const tag of imgs(markup)) {
            expect(tag).toContain('alt=""');
            expect(tag).toContain('draggable="false"');
        }
    });

    it("keeps its slot square and draws the file at the size the provider's rules give it", () => {
        const markup = html("opencode", 16);
        expect(markup).toMatch(/^<span [^>]*style="width:16px;height:16px"/);
        const [tag] = imgs(markup);
        expect(attr(tag, "style")).toContain("height:20px");
        expect(attr(tag, "style")).toContain("width:16px");
        expect(attr(tag, "style")).toContain("max-width:none");
    });

    it("answers the library's catalogue ids too", () => {
        expect(hasProviderMark("claude-code")).toBe(true);
        expect(imgs(html("claude-code"))).toHaveLength(1);
    });
});

describe("the mark of an agent that has none", () => {
    it("draws nothing, so the surface keeps its own generic glyph", () => {
        for (const agent of ["kimi", "vibe", "unknown", ""]) {
            expect(hasProviderMark(agent), agent).toBe(false);
            expect(html(agent), agent).toBe("");
        }
        expect(hasProviderMark(undefined)).toBe(false);
    });
});

describe("the stylesheet shows the file that reads on the theme", () => {
    it("shows the dark surface's file by default and the light surface's file on the light theme", () => {
        expect(Css).toMatch(/\.mt-pmark img\[data-tone="on-light"\] \{\s*display: none;/);
        expect(Css).toMatch(/:root\.mt-light \.mt-pmark img\[data-tone="on-dark"\] \{\s*display: none;/);
        expect(Css).toMatch(/:root\.mt-light \.mt-pmark img\[data-tone="on-light"\] \{\s*display: block;/);
    });

    it("keeps the dark file inside a panel that stays dark in the light theme", () => {
        expect(Css).toMatch(
            /:root\.mt-light \[data-mt-dark-surface\] \.mt-pmark img\[data-tone="on-dark"\] \{\s*display: block;/
        );
        expect(Css).toMatch(
            /:root\.mt-light \[data-mt-dark-surface\] \.mt-pmark img\[data-tone="on-light"\] \{\s*display: none;/
        );
    });

    it("never recolours a file: no filter, no mask, no blend, no opacity", () => {
        expect(Css).not.toMatch(/filter\s*:|mask|mix-blend|opacity|currentColor|fill\s*:/i);
    });
});
