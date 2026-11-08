// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A view that is only one site wears that site's icon in the sidebar (#1962, FR-SHELL-081 AC21-AC29, DS-SHELL-126), end to end
// from the tab's meta, its blocks and the icons known: one page, several pages of one site, a custom icon, no icon, the
// icon following the page, the previous icon staying while a page loads, and the icon menu's preview of a mixed view.

import { initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { faviconsAtom, noteSiteLoading, resetFaviconCacheForTest } from "../favicon/favicon-store";
import { screenGlyphAtom, ViewGlyph, viewGlyphAtom } from "./view-glyph";
import { isGlyphFavicon, siteIconChoice, ViewIconMetaKey, type GlyphFavicon } from "./view-menu-model";
import { openViewPopover, ViewPopoverHost } from "./view-popover";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-a", windowId: "win-a", clientId: "c", platform: "darwin" } as any);
});

// Wave's own web view, which only layouts saved before MoltenTerm's browser panel still hold.
const WaveWebView = "web";
const Notion = "https://notion.so";
const Linear = "https://linear.app";
const Mail = "https://mail.google.com";
const Docs = "https://docs.google.com";
const NotionIcon = { url: "data:image/png;base64,Tk9USU9O" };
const LinearIcon = { url: "data:image/png;base64,TElORUFS" };
const MailIcon = { url: "data:image/png;base64,TUFJTA==", dark: true };

function page(url: string, extra: Record<string, any> = {}) {
    return {
        view: "molten-browser",
        "molten:browser:tabs": [{ id: "t1", url, title: "A page" }],
        "molten:browser:active": "t1",
        ...extra,
    };
}

function seedBlock(id: string, meta: Record<string, any>) {
    globalStore.get(WOS.getWaveObjectAtom(WOS.makeORef("block", id)));
    WOS.setObjectValue({ otype: "block", oid: id, version: 1, meta } as any);
}

let version = 1;
function seedTab(tabId: string, blocks: Record<string, Record<string, any>>, meta: Record<string, any> = {}) {
    for (const [id, blockMeta] of Object.entries(blocks)) {
        seedBlock(id, blockMeta);
    }
    globalStore.get(WOS.getWaveObjectAtom(WOS.makeORef("tab", tabId)));
    version++;
    WOS.setObjectValue({ otype: "tab", oid: tabId, version, blockids: Object.keys(blocks), meta } as any);
}

function known(icons: Record<string, { url: string; dark?: boolean }>) {
    globalStore.set(faviconsAtom, icons);
}

const glyph = (tabId: string) => globalStore.get(viewGlyphAtom(tabId));
const fav = (value: unknown) => value as GlyphFavicon;

beforeEach(() => {
    resetFaviconCacheForTest();
});

describe("a view that is only one site (#1962)", () => {
    it("takes the site's icon when it holds one page, instead of the globe", () => {
        known({ [Notion]: NotionIcon });
        seedTab("t-one", { "b-one": page(`${Notion}/workspace`) });
        const marks = glyph("t-one");
        expect(marks).toHaveLength(1);
        expect(isGlyphFavicon(marks[0])).toBe(true);
        expect(marks[0]).toEqual({ favicon: true, origin: Notion, url: NotionIcon.url });
    });

    it("takes it when it holds several pages of the same site, and only one mark", () => {
        known({ [Mail]: MailIcon, [Docs]: NotionIcon });
        seedTab("t-same", { "b-mail": page(`${Mail}/inbox`), "b-docs": page(`${Docs}/d/1`) });
        const marks = glyph("t-same");
        expect(marks).toHaveLength(1);
        expect(fav(marks[0]).origin).toBe(Mail);
        expect(fav(marks[0]).dark).toBe(true);
    });

    it("uses the first origin whose icon is known when the first page's site has none yet", () => {
        known({ [Docs]: NotionIcon });
        seedTab("t-second", { "b-mail2": page(`${Mail}/inbox`), "b-docs2": page(`${Docs}/d/1`) });
        expect(fav(glyph("t-second")[0]).origin).toBe(Docs);
    });

    it("keeps the usual icons for pages of different sites", () => {
        known({ [Notion]: NotionIcon, [Linear]: LinearIcon });
        seedTab("t-diff", { "b-n": page(`${Notion}/a`), "b-l": page(`${Linear}/b`) });
        expect(glyph("t-diff")).toEqual(["globe", "globe"]);
    });

    it("keeps the usual icons when another kind of panel is in the view", () => {
        known({ [Notion]: NotionIcon });
        seedTab("t-mixed", { "b-np": page(`${Notion}/a`), "b-term": { view: "term", controller: "shell" } });
        expect(glyph("t-mixed")).toEqual(["globe", "terminal"]);
    });

    it("keeps the terminal's icon for a view that is not a page at all", () => {
        known({ [Notion]: NotionIcon });
        seedTab("t-term", { "b-t2": { view: "term", controller: "shell" } });
        expect(glyph("t-term")).toEqual(["terminal"]);
    });

    it("falls back to the generic web icon when the site's icon was never kept", () => {
        known({});
        seedTab("t-none", { "b-none": page(`${Notion}/a`) });
        expect(glyph("t-none")).toEqual(["globe"]);
    });

    it("treats a page without a web address as no site", () => {
        known({ [Notion]: NotionIcon });
        seedTab("t-start", { "b-start": { view: "molten-browser" } });
        expect(glyph("t-start")).toEqual(["globe"]);
    });

    it("applies to Wave's own web view, which keeps its address in the block's url", () => {
        known({ [Linear]: LinearIcon });
        seedTab("t-wave", { "b-wave": { view: WaveWebView, url: `${Linear}/team` } });
        expect(fav(glyph("t-wave")[0]).origin).toBe(Linear);
    });

    it("lets the icon the developer chose win, an icon name or a site's", () => {
        known({ [Notion]: NotionIcon, [Linear]: LinearIcon });
        seedTab("t-chosen", { "b-ch": page(`${Notion}/a`) }, { [ViewIconMetaKey]: "gauge" });
        expect(glyph("t-chosen")).toEqual(["gauge"]);
        seedTab(
            "t-site",
            { "b-site": { view: "term", controller: "shell" } },
            { [ViewIconMetaKey]: siteIconChoice(Linear) }
        );
        expect(fav(glyph("t-site")[0]).origin).toBe(Linear);
        seedTab(
            "t-site-none",
            { "b-sn": page(`${Notion}/a`) },
            { [ViewIconMetaKey]: siteIconChoice("https://nowhere.test") }
        );
        expect(glyph("t-site-none")).toEqual(["globe"]);
    });

    it("follows the page: navigating to another site changes the icon", () => {
        known({ [Notion]: NotionIcon, [Linear]: LinearIcon });
        seedTab("t-nav", { "b-nav": page(`${Notion}/a`) });
        expect(fav(glyph("t-nav")[0]).origin).toBe(Notion);
        seedBlock("b-nav", page(`${Linear}/b`));
        expect(fav(glyph("t-nav")[0]).origin).toBe(Linear);
    });

    it("keeps the previous icon while the new page loads, then the globe if it has none", () => {
        known({ [Notion]: NotionIcon });
        seedTab("t-load", { "b-load": page(`${Notion}/a`) });
        expect(fav(glyph("t-load")[0]).origin).toBe(Notion);
        noteSiteLoading("b-load", true);
        seedBlock("b-load", page("https://no-icon.test/a"));
        expect(fav(glyph("t-load")[0]).origin).toBe(Notion);
        noteSiteLoading("b-load", false);
        expect(glyph("t-load")).toEqual(["globe"]);
    });

    it("takes the new icon as soon as it is known, even before the load ends", () => {
        known({ [Notion]: NotionIcon });
        seedTab("t-arrive", { "b-arrive": page(`${Notion}/a`) });
        glyph("t-arrive");
        noteSiteLoading("b-arrive", true);
        seedBlock("b-arrive", page(`${Linear}/b`));
        expect(fav(glyph("t-arrive")[0]).origin).toBe(Notion);
        known({ [Notion]: NotionIcon, [Linear]: LinearIcon });
        expect(fav(glyph("t-arrive")[0]).origin).toBe(Linear);
    });

    it("goes back to the usual icons when a second kind of panel arrives, and returns when it leaves", () => {
        known({ [Notion]: NotionIcon });
        seedTab("t-grow", { "b-grow": page(`${Notion}/a`) });
        expect(fav(glyph("t-grow")[0]).origin).toBe(Notion);
        seedTab("t-grow", { "b-grow": page(`${Notion}/a`), "b-grow-term": { view: "term", controller: "shell" } });
        expect(glyph("t-grow")).toEqual(["globe", "terminal"]);
        seedTab("t-grow", { "b-grow": page(`${Notion}/a`) });
        expect(fav(glyph("t-grow")[0]).origin).toBe(Notion);
    });
});

describe("the icon menu's preview of a mixed view (#1962)", () => {
    it("shows each web page's own icon next to its panel, the view's icon staying the usual one", () => {
        known({ [Notion]: NotionIcon, [Linear]: LinearIcon });
        seedTab("t-prev", {
            "b-pn": page(`${Notion}/a`),
            "b-pt": { view: "term", controller: "shell" },
            "b-pl": page(`${Linear}/b`),
        });
        expect(glyph("t-prev")).toEqual(["globe", "terminal", "globe"]);
        const preview = globalStore.get(screenGlyphAtom("t-prev"));
        expect(preview).toHaveLength(3);
        expect(fav(preview[0]).origin).toBe(Notion);
        expect(preview[1]).toBe("terminal");
        expect(fav(preview[2]).origin).toBe(Linear);
    });

    it("shows a page whose site has no known icon as the globe", () => {
        known({ [Notion]: NotionIcon });
        seedTab("t-prev2", { "b-p2": page(`${Linear}/b`), "b-p2t": { view: "term", controller: "shell" } });
        expect(globalStore.get(screenGlyphAtom("t-prev2"))).toEqual(["globe", "terminal"]);
    });

    it("shows the site's icon alone for a view that is only that site", () => {
        known({ [Notion]: NotionIcon });
        seedTab("t-prev3", { "b-p3": page(`${Notion}/a`) });
        expect(globalStore.get(screenGlyphAtom("t-prev3")).map((i) => fav(i).origin)).toEqual([Notion]);
    });
});

describe("the icon menu offers the site's icon (#1962)", () => {
    function menuHtml(tabId: string, icon: string) {
        openViewPopover({ kind: "icon", ref: { tabId }, name: "Work", icon, x: 0, y: 0 });
        return renderToStaticMarkup(
            <Provider store={globalStore}>
                <ViewPopoverHost />
            </Provider>
        );
    }

    it("asks main for every page's icon of a mixed view: after a restart nothing else brings a kept icon back", async () => {
        const read = vi.fn(async () => ({}));
        (globalThis as any).window = { api: { moltentermFaviconRead: read } };
        try {
            known({});
            seedTab("t-ask", {
                "b-a1": page(`${Notion}/a`),
                "b-a2": { view: "term", controller: "shell" },
                "b-a3": page(`${Linear}/b`),
            });
            globalStore.get(viewGlyphAtom("t-ask"));
            await Promise.resolve();
            expect(read).not.toHaveBeenCalled();
            menuHtml("t-ask", null);
            await vi.waitFor(() => expect(read).toHaveBeenCalledWith([Notion, Linear]));
        } finally {
            delete (globalThis as any).window;
        }
    });

    it("offers one choice per site the view shows pages of whose icon is known, with the site's name", () => {
        known({ [Notion]: NotionIcon, [Linear]: LinearIcon });
        seedTab("t-menu", {
            "b-m1": page(`${Notion}/a`),
            "b-m2": { view: "term", controller: "shell" },
            "b-m3": page(`${Linear}/b`),
            "b-m4": page("https://unknown.test/c"),
        });
        const html = menuHtml("t-menu", null);
        expect(html.match(/data-testid="sidebar-icon-site"/g)).toHaveLength(2);
        expect(html).toContain(`data-origin="${Notion}"`);
        expect(html).toContain(`data-origin="${Linear}"`);
        expect(html).not.toContain("unknown.test");
        expect(html).toContain("Use the site&#x27;s icon");
        expect(html).toContain("notion.so");
        expect(html).toContain(`src="${NotionIcon.url}"`);
    });

    it("offers nothing for a view with no page, and marks the choice that is chosen", () => {
        known({ [Notion]: NotionIcon });
        seedTab("t-menu-none", { "b-mn": { view: "term", controller: "shell" } });
        expect(menuHtml("t-menu-none", null)).not.toContain("sidebar-icon-site");
        seedTab("t-menu-on", { "b-mo": page(`${Notion}/a`) }, { [ViewIconMetaKey]: siteIconChoice(Notion) });
        const on = menuHtml("t-menu-on", siteIconChoice(Notion));
        expect(on).toMatch(/aria-pressed="true"[^>]*data-testid="sidebar-icon-site"/);
    });

    it("keeps the way back to the automatic icon, previewing what the view shows now", () => {
        known({ [Notion]: NotionIcon });
        seedTab("t-menu-back", { "b-mb": page(`${Notion}/a`) }, { [ViewIconMetaKey]: "gauge" });
        const html = menuHtml("t-menu-back", "gauge");
        const back = html.slice(html.indexOf('data-testid="sidebar-icon-panels"'));
        expect(back).toContain("What the view shows");
        expect(back).toContain(`src="${NotionIcon.url}"`);
    });
});

describe("drawing a site's icon", () => {
    it("is an image of the icon, on a plate when it is too dark, and the globe with no icon", () => {
        const light = renderToStaticMarkup(
            <ViewGlyph icons={[{ favicon: true, origin: Notion, url: NotionIcon.url }]} />
        );
        expect(light).toContain("<img");
        expect(light).toContain(`src="${NotionIcon.url}"`);
        expect(light).not.toContain("is-dark");
        const dark = renderToStaticMarkup(
            <ViewGlyph icons={[{ favicon: true, origin: Mail, url: MailIcon.url, dark: true }]} small />
        );
        expect(dark).toContain("is-dark");
        const generic = renderToStaticMarkup(<ViewGlyph icons={["globe"]} />);
        expect(generic).not.toContain("<img");
        expect(generic).toContain("fa-globe");
    });

    it("never draws an icon as markup: an SVG icon is only ever the source of an image", () => {
        const svg = "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+";
        const html = renderToStaticMarkup(<ViewGlyph icons={[{ favicon: true, origin: Notion, url: svg }]} />);
        expect(html).toContain("<img");
        expect(html).not.toContain("<script");
        expect(html).not.toContain("<svg");
    });
});
