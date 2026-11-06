// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    isPageView,
    originOfAddress,
    pageLineOf,
    pageTitleOfMeta,
    pageUrlOfMeta,
    panelSiteOf,
    registrableDomain,
    siteNameOf,
    siteOnlyOrigins,
} from "./site";

// Wave's own web view, which only layouts saved before MoltenTerm's browser panel still hold.
const WaveWebView = "web";

const page = (url: string, title = "") => ({
    view: "molten-browser",
    url: "https://opened-at.test/",
    "molten:browser:tabs": [{ id: "t1", url, title }],
    "molten:browser:active": "t1",
});

describe("the site of an address", () => {
    it("names the origin and the site, without www, for a web address only", () => {
        expect(originOfAddress("https://www.notion.so/a/b?c=1#d")).toBe("https://www.notion.so");
        expect(siteNameOf("https://www.notion.so/a")).toBe("notion.so");
        expect(siteNameOf("http://localhost:3000/x")).toBe("localhost");
        for (const address of ["", "x", "file:///a", "data:text/html,x", "moltenterm://start", null, undefined]) {
            expect(originOfAddress(address as string)).toBe("");
            expect(siteNameOf(address as string)).toBe("");
        }
    });

    it("makes a site of the registrable domain: two hosts of one company are one site", () => {
        expect(registrableDomain("mail.google.com")).toBe("google.com");
        expect(registrableDomain("docs.google.com")).toBe("google.com");
        expect(registrableDomain("google.com")).toBe("google.com");
        expect(registrableDomain("a.b.c.example.org")).toBe("example.org");
    });

    it("keeps a country's second-level suffix and a hosting platform's subdomain apart", () => {
        expect(registrableDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
        expect(registrableDomain("shop.example.com.au")).toBe("example.com.au");
        expect(registrableDomain("alice.github.io")).toBe("alice.github.io");
        expect(registrableDomain("bob.github.io")).not.toBe(registrableDomain("alice.github.io"));
        expect(registrableDomain("app.vercel.app")).toBe("app.vercel.app");
    });

    it("leaves a host that has no domain structure as it is", () => {
        expect(registrableDomain("localhost")).toBe("localhost");
        expect(registrableDomain("192.168.1.20")).toBe("192.168.1.20");
        expect(registrableDomain("[::1]")).toBe("[::1]");
        expect(registrableDomain("")).toBe("");
    });
});

describe("the page a panel shows", () => {
    it("is the shown tab's address and title, not the address the panel opened at", () => {
        const meta = page("https://linear.app/team", "Team");
        expect(pageUrlOfMeta(meta)).toBe("https://linear.app/team");
        expect(pageTitleOfMeta(meta)).toBe("Team");
    });

    it("falls back to the block's own address, as Wave's web view keeps it", () => {
        expect(pageUrlOfMeta({ view: WaveWebView, url: "https://a.test/" })).toBe("https://a.test/");
        expect(pageUrlOfMeta({ view: "molten-browser", url: "https://a.test/" })).toBe("https://a.test/");
        expect(pageUrlOfMeta(null)).toBe("");
        expect(pageTitleOfMeta({ view: WaveWebView })).toBe("");
    });

    it("takes the active tab among several, else the first", () => {
        const tabs = [
            { id: "a", url: "https://a.test/" },
            { id: "b", url: "https://b.test/" },
        ];
        expect(pageUrlOfMeta({ "molten:browser:tabs": tabs, "molten:browser:active": "b" })).toBe("https://b.test/");
        expect(pageUrlOfMeta({ "molten:browser:tabs": tabs, "molten:browser:active": "gone" })).toBe("https://a.test/");
    });

    it("says which views are web pages", () => {
        expect(isPageView("molten-browser")).toBe(true);
        expect(isPageView("web")).toBe(true);
        expect(isPageView("term")).toBe(false);
        expect(isPageView(undefined)).toBe(false);
    });

    it("tells a page's panel from the others, and a page with no web address from one with it", () => {
        expect(panelSiteOf({ view: "term" })).toEqual({ page: false });
        expect(panelSiteOf(null)).toEqual({ page: false });
        expect(panelSiteOf(page("https://mail.google.com/x"))).toEqual({
            page: true,
            origin: "https://mail.google.com",
            domain: "google.com",
        });
        expect(panelSiteOf({ view: "molten-browser" })).toEqual({ page: true, origin: "", domain: "" });
    });

    it("gives a tooltip line: the title and the site, or the site alone", () => {
        expect(pageLineOf(page("https://www.notion.so/x", "My space"))).toBe("My space · notion.so");
        expect(pageLineOf(page("https://notion.so/x", ""))).toBe("notion.so");
        expect(pageLineOf(page("https://notion.so/x", "notion.so"))).toBe("notion.so");
        expect(pageLineOf({ view: "term" })).toBe("");
        expect(pageLineOf({ view: "molten-browser" })).toBe("");
    });
});

describe("a view that is only one site", () => {
    const site = (url: string) => panelSiteOf(page(url));
    const terminal = panelSiteOf({ view: "term" });

    it("is one page, or several pages of one registrable domain, in the panels' order and distinct", () => {
        expect(siteOnlyOrigins([site("https://notion.so/a")])).toEqual(["https://notion.so"]);
        expect(siteOnlyOrigins([site("https://mail.google.com/a"), site("https://docs.google.com/b")])).toEqual([
            "https://mail.google.com",
            "https://docs.google.com",
        ]);
        expect(siteOnlyOrigins([site("https://notion.so/a"), site("https://notion.so/b")])).toEqual([
            "https://notion.so",
        ]);
    });

    it("is not, with another kind of panel, pages of different sites, a page without an address or no panel", () => {
        expect(siteOnlyOrigins([site("https://notion.so/a"), terminal])).toEqual([]);
        expect(siteOnlyOrigins([terminal])).toEqual([]);
        expect(siteOnlyOrigins([site("https://notion.so/a"), site("https://linear.app/b")])).toEqual([]);
        expect(siteOnlyOrigins([site("https://alice.github.io/"), site("https://bob.github.io/")])).toEqual([]);
        expect(siteOnlyOrigins([panelSiteOf({ view: "molten-browser" })])).toEqual([]);
        expect(siteOnlyOrigins([site("https://notion.so/a"), panelSiteOf({ view: "molten-browser" })])).toEqual([]);
        expect(siteOnlyOrigins([])).toEqual([]);
        expect(siteOnlyOrigins(null)).toEqual([]);
    });
});
