// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The rules of the web page panel's inspector and site data (FR-BRW-022, DS-BRW-027), kept apart from Electron so they
// are tested alone: where the docked tools go, which point Inspect selects, which origin a page clears, and which
// cookies belong to it.

// A rectangle the window sends is CSS pixels of its tab view; anything this large is a bug, not a panel.
const MaxCssPx = 100000;

// What a site keeps besides its cookies and its HTTP cache (session.clearStorageData).
export const SiteStorages = ["filesystem", "indexdb", "localstorage", "serviceworkers", "cachestorage"] as const;

export type ViewBounds = { x: number; y: number; width: number; height: number };

function finiteIn(value: unknown, min: number, max: number): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function zoomOf(zoom: number): number {
    return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

// The docked tools' bounds in the tab view (DIP: CSS pixels times the window's zoom), and whether they show. null for a
// rectangle that is not one.
export function placeBounds(raw: unknown, zoom: number): { bounds: ViewBounds; visible: boolean } {
    const r = raw as Record<string, unknown>;
    if (r == null || typeof r !== "object") {
        return null;
    }
    if (
        !finiteIn(r.x, -MaxCssPx, MaxCssPx) ||
        !finiteIn(r.y, -MaxCssPx, MaxCssPx) ||
        !finiteIn(r.width, 0, MaxCssPx) ||
        !finiteIn(r.height, 0, MaxCssPx)
    ) {
        return null;
    }
    const z = zoomOf(zoom);
    const bounds = {
        x: Math.round(r.x * z),
        y: Math.round(r.y * z),
        width: Math.round(r.width * z),
        height: Math.round(r.height * z),
    };
    return { bounds, visible: r.visible === true && bounds.width >= 1 && bounds.height >= 1 };
}

// The point Inspect selects, in DIP: the right-click's point in the window's CSS pixels times the window's zoom.
export function inspectPoint(raw: unknown, zoom: number): { x: number; y: number } {
    const r = raw as Record<string, unknown>;
    if (r == null || typeof r !== "object" || !finiteIn(r.x, 0, MaxCssPx) || !finiteIn(r.y, 0, MaxCssPx)) {
        return null;
    }
    const z = zoomOf(zoom);
    return { x: Math.round(r.x * z), y: Math.round(r.y * z) };
}

export {
    ClearCacheKind,
    ClearSiteKind,
    siteOriginOf,
    type SiteOrigin,
} from "../frontend/moltenterm-shell/browser/site-data";

export type CookieFacts = {
    name: string;
    value?: string;
    domain?: string;
    hostOnly?: boolean;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    session?: boolean;
    expirationDate?: number;
    sameSite?: string;
};

export function cookieHost(cookie: CookieFacts): string {
    return (cookie?.domain ?? "").replace(/^\./, "").toLowerCase();
}

// The cookies a site's data holds: the host-only cookies of its very host. A domain cookie (Domain=example.com, or even
// Domain=app.example.com) is sent to other sites of that domain too (a sign-in on every subdomain): it stays, so the
// confirmation's promise that the sign-ins elsewhere stay holds.
export function ownCookies<T extends CookieFacts>(cookies: T[], host: string): T[] {
    const h = (host ?? "").toLowerCase();
    return (cookies ?? []).filter((c) => c.hostOnly === true && cookieHost(c) === h);
}

function urlHost(host: string): string {
    return host.includes(":") ? `[${host}]` : host;
}

// The address cookies.remove and cookies.set name a cookie by.
export function cookieUrl(cookie: CookieFacts): string {
    const path = cookie.path && cookie.path.startsWith("/") ? cookie.path : "/";
    return `${cookie.secure ? "https" : "http"}://${urlHost(cookieHost(cookie))}${path}`;
}

function cookieKey(cookie: CookieFacts): string {
    return [cookie.domain ?? "", cookie.path ?? "/", cookie.name].join("\u0000");
}

// cookies.remove(url, name) takes every cookie of that name sent to the address, the shared domain cookies too: those
// that were there before, were not to go and are gone after go back.
export function cookiesToRestore<T extends CookieFacts>(before: T[], after: T[], removed: CookieFacts[]): T[] {
    const left = new Set((after ?? []).map(cookieKey));
    const meant = new Set((removed ?? []).map(cookieKey));
    return (before ?? []).filter((c) => !meant.has(cookieKey(c)) && !left.has(cookieKey(c)));
}

// The details that set a cookie back as it was.
export function restoreDetails(cookie: CookieFacts): Electron.CookiesSetDetails {
    const details: Electron.CookiesSetDetails = {
        url: cookieUrl(cookie),
        name: cookie.name,
        value: cookie.value ?? "",
        path: cookie.path ?? "/",
        secure: cookie.secure === true,
        httpOnly: cookie.httpOnly === true,
    };
    if (!cookie.hostOnly && cookie.domain) {
        details.domain = cookie.domain;
    }
    if (!cookie.session && Number.isFinite(cookie.expirationDate)) {
        details.expirationDate = cookie.expirationDate;
    }
    if (cookie.sameSite) {
        details.sameSite = cookie.sameSite as Electron.CookiesSetDetails["sameSite"];
    }
    return details;
}
