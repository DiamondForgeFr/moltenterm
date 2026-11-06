// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Which site a panel shows, and whether a view is only that site (#1962, FR-SHELL-081 AC21-AC29, DS-SHELL-126): the pure rules
// behind the icon a view takes in the sidebar, kept apart from the components so they are tested without the app. A site
// is a registrable domain (mail.google.com and docs.google.com are one site, google.com); the icon itself is kept per
// origin (emain/moltenterm-favicons.ts).

import { BrowserActiveMetaKey, BrowserTabsMetaKey, MoltentermBrowserView } from "../browser/browser-model";

// The icon of a web page whose site has none to show: the same globe a web page panel has always had.
export const GenericWebIcon = "globe";

// Wave's own web view, kept as it opens in a layout saved before MoltenTerm's browser panel took its place.
const WebViewType = "web";

export function isPageView(view: string): boolean {
    return view === MoltentermBrowserView || view === WebViewType;
}

// The suffixes under which two names are two sites, not one: a country's second-level names and the hosting platforms
// whose subdomains belong to different people. The public suffix list holds thousands; this is the part a developer's
// sidebar meets, and a host it does not list is treated as one site per its last two labels.
const SharedSuffixes = new Set([
    "co.uk",
    "org.uk",
    "gov.uk",
    "ac.uk",
    "me.uk",
    "ltd.uk",
    "plc.uk",
    "net.uk",
    "sch.uk",
    "com.au",
    "net.au",
    "org.au",
    "edu.au",
    "gov.au",
    "co.nz",
    "org.nz",
    "net.nz",
    "co.jp",
    "ne.jp",
    "or.jp",
    "ac.jp",
    "go.jp",
    "com.br",
    "net.br",
    "org.br",
    "gov.br",
    "com.cn",
    "net.cn",
    "org.cn",
    "gov.cn",
    "com.hk",
    "com.tw",
    "com.sg",
    "com.mx",
    "com.ar",
    "com.tr",
    "com.ua",
    "com.pl",
    "co.za",
    "co.in",
    "net.in",
    "org.in",
    "co.kr",
    "or.kr",
    "co.il",
    "co.id",
    "co.th",
    "com.my",
    "com.vn",
    "com.ph",
    "com.eg",
    "com.sa",
    "com.ng",
    "co.ke",
    "github.io",
    "gitlab.io",
    "pages.dev",
    "workers.dev",
    "vercel.app",
    "netlify.app",
    "herokuapp.com",
    "web.app",
    "firebaseapp.com",
    "appspot.com",
    "blogspot.com",
    "azurewebsites.net",
    "cloudfront.net",
    "fly.dev",
    "onrender.com",
]);

const Ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function registrableDomain(host: string): string {
    const name = (host ?? "").toLowerCase().replace(/\.$/, "");
    if (name === "" || name.includes(":") || Ipv4.test(name)) {
        return name;
    }
    const labels = name.split(".");
    if (labels.length <= 2) {
        return name;
    }
    const last2 = labels.slice(-2).join(".");
    return SharedSuffixes.has(last2) ? labels.slice(-3).join(".") : last2;
}

function parseWebAddress(address: unknown): URL {
    if (typeof address !== "string" || address === "") {
        return null;
    }
    try {
        const url = new URL(address);
        return url.protocol === "http:" || url.protocol === "https:" ? url : null;
    } catch {
        return null;
    }
}

// "" for an address that is not a web page's.
export function originOfAddress(address: string): string {
    return parseWebAddress(address)?.origin ?? "";
}

// The site's name as a view shows it: the host without "www.", "" for an address that is not a web page's.
export function siteNameOf(address: string): string {
    return (parseWebAddress(address)?.hostname ?? "").replace(/^www\./i, "");
}

// The page a panel shows now: a web page panel's shown tab (its address follows the page, where the block's own "url"
// stays the address it opened at), else the block's "url".
function shownTab(meta: Record<string, any>): { url?: string; title?: string } {
    const tabs = meta?.[BrowserTabsMetaKey];
    if (!Array.isArray(tabs) || tabs.length === 0) {
        return null;
    }
    const active = meta?.[BrowserActiveMetaKey];
    return tabs.find((t) => t != null && t.id === active) ?? tabs[0];
}

export function pageUrlOfMeta(meta: Record<string, any>): string {
    const tab = shownTab(meta);
    if (typeof tab?.url === "string" && tab.url !== "") {
        return tab.url;
    }
    return typeof meta?.url === "string" ? meta.url : "";
}

export function pageTitleOfMeta(meta: Record<string, any>): string {
    const title = shownTab(meta)?.title;
    return typeof title === "string" ? title.trim() : "";
}

export type PanelSite =
    // A web page: its origin is "" when the address is not a web address (the start page, a page not loaded yet).
    { page: true; origin: string; domain: string } | { page: false };

export function panelSiteOf(meta: Record<string, any>): PanelSite {
    if (!isPageView(meta?.view)) {
        return { page: false };
    }
    const origin = originOfAddress(pageUrlOfMeta(meta));
    return { page: true, origin, domain: origin === "" ? "" : registrableDomain(new URL(origin).hostname) };
}

// The origins a view shows when it is only one site: every panel is a web page on a web address and they all share a
// registrable domain. Distinct, in the panels' order; [] for any other view (another kind of panel, pages of different
// sites, a page without an address, no panel).
export function siteOnlyOrigins(panels: PanelSite[]): string[] {
    if (panels == null || panels.length === 0) {
        return [];
    }
    const origins: string[] = [];
    let domain = "";
    for (const panel of panels) {
        if (!panel.page || panel.origin === "") {
            return [];
        }
        if (domain !== "" && panel.domain !== domain) {
            return [];
        }
        domain = panel.domain;
        if (!origins.includes(panel.origin)) {
            origins.push(panel.origin);
        }
    }
    return origins;
}

// A page panel's lines for a tooltip, where a native tooltip can hold text only: the page's title and its site.
export function pageLineOf(meta: Record<string, any>): string {
    const panel = panelSiteOf(meta);
    if (!panel.page) {
        return "";
    }
    const site = siteNameOf(pageUrlOfMeta(meta));
    const title = pageTitleOfMeta(meta);
    if (title === "") {
        return site;
    }
    return site === "" || title === site ? title : `${title} · ${site}`;
}
