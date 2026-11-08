// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { faviconGlyphOf, loadingSiteIcon, panelFaviconOf, siteViewIcon, viewSiteOrigins } from "./site-glyph";

const Notion = "https://notion.so";
const icons = {
    [Notion]: { url: "data:image/png;base64,AAAA" },
    "https://dark.test": { url: "data:image/png;base64,BBBB", dark: true },
};
const page = (url: string) => ({ view: "molten-browser", url });

describe("a site's icon as a glyph", () => {
    it("is the image of the origin's kept icon, with its dark measure when it has one", () => {
        expect(faviconGlyphOf(Notion, icons)).toEqual({ favicon: true, origin: Notion, url: icons[Notion].url });
        expect(faviconGlyphOf("https://dark.test", icons)).toEqual({
            favicon: true,
            origin: "https://dark.test",
            url: "data:image/png;base64,BBBB",
            dark: true,
        });
    });

    it("is nothing for an origin whose icon was never kept, or an unusable one", () => {
        expect(faviconGlyphOf("https://other.test", icons)).toBeNull();
        expect(faviconGlyphOf("", icons)).toBeNull();
        expect(faviconGlyphOf(Notion, undefined)).toBeNull();
        expect(faviconGlyphOf(Notion, { [Notion]: { url: "" } })).toBeNull();
    });
});

describe("the icon a view takes from its site", () => {
    it("is the site's icon for a view of one page, nothing for a view that is more", () => {
        expect(siteViewIcon([page(`${Notion}/a`)], icons).origin).toBe(Notion);
        expect(siteViewIcon([page(`${Notion}/a`), { view: "term" }], icons)).toBeNull();
        expect(siteViewIcon([page(`${Notion}/a`), page("https://linear.app/b")], icons)).toBeNull();
        expect(siteViewIcon([page("https://other.test/a")], icons)).toBeNull();
        expect(siteViewIcon([], icons)).toBeNull();
    });

    it("looks at every tab of a panel, not only the one in front", () => {
        const panel = (urls: string[]) => ({
            view: "molten-browser",
            "molten:browser:tabs": urls.map((url, i) => ({ id: `t${i}`, url })),
            "molten:browser:active": "t0",
        });
        expect(siteViewIcon([panel([`${Notion}/a`, "https://linear.app/b"])], icons)).toBeNull();
        expect(viewSiteOrigins([panel([`${Notion}/a`, `${Notion}/b`])])).toEqual([Notion]);
        expect(viewSiteOrigins([panel([`${Notion}/a`, "https://www.notion.so/b"])])).toEqual([
            Notion,
            "https://www.notion.so",
        ]);
        expect(siteViewIcon([panel([`${Notion}/a`, "molten://start"])], icons).origin).toBe(Notion);
    });

    it("lists the origins a view is only one site of", () => {
        expect(viewSiteOrigins([page(`${Notion}/a`), page(`${Notion}/b`)])).toEqual([Notion]);
        expect(viewSiteOrigins([page(`${Notion}/a`), { view: "term" }])).toEqual([]);
        expect(viewSiteOrigins(undefined)).toEqual([]);
    });

    it("gives a page panel its own icon, and nothing for another panel", () => {
        expect(panelFaviconOf(page(`${Notion}/a`), icons).origin).toBe(Notion);
        expect(panelFaviconOf({ view: "term" }, icons)).toBeNull();
        expect(panelFaviconOf(page("https://other.test/"), icons)).toBeNull();
    });
});

describe("the icon kept while a page loads", () => {
    const before = { favicon: true as const, origin: Notion, url: "a" };
    const after = { favicon: true as const, origin: "https://linear.app", url: "b" };

    it("shows the new icon as soon as it is known", () => {
        expect(loadingSiteIcon(before, after, true)).toEqual({ shown: after, remembered: after });
        expect(loadingSiteIcon(null, after, false)).toEqual({ shown: after, remembered: after });
    });

    it("keeps the previous icon while the page loads and has none yet", () => {
        expect(loadingSiteIcon(before, null, true)).toEqual({ shown: before, remembered: before });
    });

    it("gives it up once the load has ended without an icon, and shows none with nothing before", () => {
        expect(loadingSiteIcon(before, null, false)).toEqual({ shown: null, remembered: null });
        expect(loadingSiteIcon(null, null, true)).toEqual({ shown: null, remembered: null });
    });
});
