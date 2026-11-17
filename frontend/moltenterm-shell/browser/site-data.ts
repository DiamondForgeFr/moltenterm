// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The site whose data "Clear this site's data…" removes (FR-BRW-022): the page's origin, for http and https pages
// only, and the host its cookies belong to. The window asks with it and emain checks the page still shows it
// (emain/moltenterm-browser-inspector.ts), so both read it here.

export type SiteOrigin = { origin: string; host: string };

export const ClearSiteKind = "site";
export const ClearCacheKind = "cache";

export function siteOriginOf(url: unknown): SiteOrigin {
    if (typeof url !== "string" || url === "") {
        return null;
    }
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "") {
        return null;
    }
    return { origin: parsed.origin, host };
}
