// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The icon a view takes from its site (#1962, FR-SHELL-081 AC21-AC29, DS-SHELL-126): the rule, from the panels' sites and the
// icons known, and the memory that keeps the previous icon on a view while its page loads. Pure, so it is tested without
// the app; view-glyph.tsx and sidebar-blocks.ts apply it.

import type { GlyphFavicon } from "../sidebar/view-menu-model";
import type { SiteIcon } from "./favicon-store";
import { panelSiteOf, panelSitesOf, siteOnlyOrigins } from "./site";

export function faviconGlyphOf(origin: string, icons: Record<string, SiteIcon>): GlyphFavicon {
    const icon = origin ? icons?.[origin] : null;
    if (icon == null || typeof icon.url !== "string" || icon.url === "") {
        return null;
    }
    return icon.dark == null
        ? { favicon: true, origin, url: icon.url }
        : { favicon: true, origin, url: icon.url, dark: icon.dark };
}

// The origins a set of panels is only one site of, [] for a view that is anything else.
export function viewSiteOrigins(panelMetas: Record<string, any>[]): string[] {
    return siteOnlyOrigins((panelMetas ?? []).flatMap((meta) => panelSitesOf(meta)));
}

// The icon of a view that is only one site: the first of its origins whose icon is known; null when none is, and the
// view keeps its usual icons (a web page's globe). A view that is not only one site never gets one.
export function siteViewIcon(panelMetas: Record<string, any>[], icons: Record<string, SiteIcon>): GlyphFavicon {
    for (const origin of viewSiteOrigins(panelMetas)) {
        const glyph = faviconGlyphOf(origin, icons);
        if (glyph != null) {
            return glyph;
        }
    }
    return null;
}

// What a view of one site shows while its page loads (#1962): the icon it showed before stays until the new page has
// said its own or has finished loading without one. previous: what the view showed last.
export function loadingSiteIcon(
    previous: GlyphFavicon,
    current: GlyphFavicon,
    loading: boolean
): { shown: GlyphFavicon; remembered: GlyphFavicon } {
    if (current != null) {
        return { shown: current, remembered: current };
    }
    if (loading && previous != null) {
        return { shown: previous, remembered: previous };
    }
    return { shown: null, remembered: null };
}

// A web page panel's own icon in a view that is more than that site (the view's icon never changes for it): the site's
// icon when it is known, else the panel's usual icon.
export function panelFaviconOf(meta: Record<string, any>, icons: Record<string, SiteIcon>): GlyphFavicon {
    const panel = panelSiteOf(meta);
    return panel.page ? faviconGlyphOf(panel.origin, icons) : null;
}
