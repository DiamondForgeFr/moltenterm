// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Links MoltenTerm's own interface opens (FR-BRW-006): where they go (DS-BRW-006) and when the first link to a site asks
// which engine to use (DS-BRW-007). Pure functions; browser-routing and the browser panel apply them.

import { BrowserList, EngineInstalled, InstalledBrowser, siteEngine, siteOf } from "./browser-engine";

export const LinkTargetPanel = "panel";
export const LinkTargetOS = "os";

// must match CustomBrowserId in pkg/molten/browsers/browsers.go
const CustomBrowserId = "custom";

export function isWebUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
    } catch {
        return false;
    }
}

// Only web pages go to the browser panel: other schemes (mailto:, app schemes) keep the OS handler, so the panel never
// runs an unknown protocol. web:openlinksinternally false restores Wave's behaviour for web pages too.
export function interfaceLinkTarget(url: string, openInternally: boolean, forceInternally: boolean): string {
    if (!isWebUrl(url)) {
        return LinkTargetOS;
    }
    return forceInternally || openInternally ? LinkTargetPanel : LinkTargetOS;
}

// The site the first link asks about, or null when there is nothing to ask: the page is not a web page, the site
// already has a choice, or browser:default is set. An absent browser:default asks; "app" or a browser id is an
// explicit default and never does.
export function choiceSite(defaultEngine: string, sites: Record<string, string>, url: string): string {
    if ((defaultEngine ?? "").trim() !== "") {
        return null;
    }
    if (siteEngine(sites, url).engine !== "") {
        return null;
    }
    return siteOf(url);
}

// The browsers the choice offers: the one pages are handed off to first, then the others detected.
export function choiceBrowsers(list: BrowserList): InstalledBrowser[] {
    const chosen = list?.chosen;
    const others = (list?.browsers ?? []).filter((b) => b.id !== chosen?.id);
    return chosen ? [chosen, ...others] : others;
}

// The engine a choice stores for a browser: one named by its path in browser:installed is stored as "installed".
export function choiceEngineId(browser: InstalledBrowser): string {
    return browser.id === CustomBrowserId ? EngineInstalled : browser.id;
}

// A tab opened by an interface link that asks for its engine. loaded: the link's own page committed, so the next
// main-frame navigation is the user moving on. keepFocus: a page a terminal program opened through BROWSER
// (FR-BRW-007); the bar shows without taking the focus from the terminal.
export type EngineChoice = { url: string; site: string; remember: boolean; loaded: boolean; keepFocus?: boolean };

export function makeEngineChoice(url: string, site: string, keepFocus?: boolean): EngineChoice {
    const choice: EngineChoice = { url, site, remember: true, loaded: false };
    if (keepFocus) {
        choice.keepFocus = true;
    }
    return choice;
}

// The first committed navigation is the link's own load (after any redirect); a later one dismisses the choice.
export function choiceOnNavigate(choice: EngineChoice): EngineChoice {
    if (choice == null) {
        return null;
    }
    return choice.loaded ? null : { ...choice, loaded: true };
}

// The bar shows while the site still has no choice (it may have been answered from another tab or the settings) and
// at least one installed browser was found; without one there is nothing to choose.
export function choiceBarVisible(
    choice: EngineChoice,
    defaultEngine: string,
    sites: Record<string, string>,
    list: BrowserList
): boolean {
    if (choice == null) {
        return false;
    }
    if (choiceSite(defaultEngine, sites, choice.url) == null) {
        return false;
    }
    return choiceBrowsers(list).length > 0;
}
