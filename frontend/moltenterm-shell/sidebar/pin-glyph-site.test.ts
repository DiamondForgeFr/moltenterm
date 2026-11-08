// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The top row's blocks (views pinned everywhere) follow the page saved in their pin, so the row is identical in every
// workspace whatever a workspace's own instance shows (#1962, #1270).

import { describe, expect, it } from "vitest";
import { pinGlyph, pinSiteOrigins, topRowBlocks } from "./sidebar-blocks";
import {
    isGlyphFavicon,
    readSiteIconChoice,
    siteIconChoice,
    viewGlyphIcons,
    type GlyphFavicon,
} from "./view-menu-model";
import { GlobalPin } from "./view-pins-model";

const Linear = "https://linear.app";
const Notion = "https://notion.so";
const icons = {
    [Linear]: { url: "data:image/png;base64,TElORUFS" },
    [Notion]: { url: "data:image/png;base64,Tk9USU9O" },
};

function pin(id: string, panes: Record<string, any>[], extra: Partial<GlobalPin> = {}): GlobalPin {
    const tree = panes.length === 1 ? { pane: 0 } : { dir: "row", children: panes.map((_, i) => ({ pane: i })) };
    return { id, name: id, rev: 1, config: { tree, panes }, ...extra };
}

const page = (url: string) => ({ view: "molten-browser", url });

describe("a top-row block of one page (#1962)", () => {
    it("wears the icon of the site its pin saved", () => {
        const glyph = pinGlyph(pin("p-lin", [page(`${Linear}/team`)]), icons);
        expect(glyph).toHaveLength(1);
        expect(isGlyphFavicon(glyph[0])).toBe(true);
        expect((glyph[0] as GlyphFavicon).origin).toBe(Linear);
    });

    it("reads the page the pin saved in its tabs, as a page panel keeps it, before the address it opened at", () => {
        const saved = {
            view: "molten-browser",
            url: `${Notion}/opened-at`,
            "molten:browser:tabs": [{ id: "t", url: `${Linear}/now` }],
            "molten:browser:active": "t",
        };
        expect((pinGlyph(pin("p-saved", [saved]), icons)[0] as GlyphFavicon).origin).toBe(Linear);
    });

    it("is the same in every workspace: what an instance shows is never read", () => {
        const block = topRowBlocks(
            [pin("p-lin", [page(`${Linear}/team`)])],
            { "p-lin": "tab-of-this-workspace" },
            icons
        )[0];
        expect((block.glyph[0] as GlyphFavicon).origin).toBe(Linear);
        const other = topRowBlocks([pin("p-lin", [page(`${Linear}/team`)])], { "p-lin": "tab-of-another" }, icons)[0];
        expect(other.glyph).toEqual(block.glyph);
    });

    it("keeps the usual icons for a pin of several kinds of panels or of several sites", () => {
        expect(pinGlyph(pin("p-mixed", [page(`${Linear}/a`), { view: "term" }]), icons)).toEqual(["globe", "terminal"]);
        expect(pinGlyph(pin("p-two", [page(`${Linear}/a`), page(`${Notion}/b`)]), icons)).toEqual(["globe", "globe"]);
    });

    it("keeps the globe when the site's icon was never kept, or with no icons at all", () => {
        expect(pinGlyph(pin("p-none", [page("https://unknown.test/")]), icons)).toEqual(["globe"]);
        expect(pinGlyph(pin("p-noicons", [page(`${Linear}/a`)]))).toEqual(["globe"]);
    });

    it("lets the icon the developer chose for the pin win, an icon name or a site's", () => {
        expect(pinGlyph(pin("p-own", [page(`${Linear}/a`)], { icon: "rocket" }), icons)).toEqual(["rocket"]);
        const chosen = pinGlyph(pin("p-site", [{ view: "term" }], { icon: siteIconChoice(Notion) }), icons);
        expect((chosen[0] as GlyphFavicon).origin).toBe(Notion);
    });
});

describe("the origins a window asks for a top-row block (#1962)", () => {
    it("is the site chosen for the pin, whatever page it saved: a kept icon reaches a window only when asked for", () => {
        expect(pinSiteOrigins(pin("p-chosen", [{ view: "term" }], { icon: siteIconChoice(Notion) }))).toEqual([Notion]);
        expect(pinSiteOrigins(pin("p-moved", [page(`${Linear}/a`)], { icon: siteIconChoice(Notion) }))).toEqual([
            Notion,
        ]);
    });

    it("is the site of the saved page otherwise, and nothing for a pin that is not one site", () => {
        expect(pinSiteOrigins(pin("p-lin", [page(`${Linear}/a`)]))).toEqual([Linear]);
        expect(pinSiteOrigins(pin("p-mixed", [page(`${Linear}/a`), { view: "term" }]))).toEqual([]);
        expect(pinSiteOrigins(pin("p-name", [page(`${Linear}/a`)], { icon: "rocket" }))).toEqual([Linear]);
    });
});

describe("a chosen site icon (#1962)", () => {
    it("names its origin, and an icon name names none", () => {
        expect(readSiteIconChoice(siteIconChoice(Linear))).toBe(Linear);
        expect(readSiteIconChoice("rocket")).toBe("");
        expect(readSiteIconChoice(null)).toBe("");
        expect(readSiteIconChoice("  ")).toBe("");
    });

    it("draws the site's icon when it is known and the generic web icon when it is not", () => {
        const known = (origin: string): GlyphFavicon =>
            origin === Linear ? { favicon: true, origin, url: icons[Linear].url } : null;
        expect(viewGlyphIcons(siteIconChoice(Linear), ["terminal"], known)).toEqual([
            { favicon: true, origin: Linear, url: icons[Linear].url },
        ]);
        expect(viewGlyphIcons(siteIconChoice(Notion), ["terminal"], known)).toEqual(["globe"]);
        expect(viewGlyphIcons(siteIconChoice(Notion), ["terminal"])).toEqual(["globe"]);
    });
});
