// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Browser › the per-site settings as lists (FR-SHELL-106): a site per row, its choice changed or the site removed,
// without editing JSON. The browser panel's bars still add the sites; these rules only change or remove what is
// stored. Pure, so the list keeps the stored shape the panel, emain and wavesrv read.

import { DecisionAllow, DecisionBlock, SitePermissionKinds, SitePermissionStore } from "../browser/site-permission";

export const SiteEnginesKey = "browser:sites";
export const AgentSitesKey = "browser:agentsites";
// must match SitePermissionsKey in browser/site-permission.ts
export const SitePermissionsListKey = "browser:sitepermissions";

export const SiteListKeys = [SiteEnginesKey, AgentSitesKey, SitePermissionsListKey];

export const SiteDecisions = [DecisionAllow, DecisionBlock];

export function isSiteListKey(key: string): boolean {
    return SiteListKeys.includes(key);
}

export type SiteRow<T> = { site: string; value: T };

// The stored sites in alphabetical order; anything that is not a map reads as no site.
export function siteRows<T>(value: unknown): SiteRow<T>[] {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
        return [];
    }
    return Object.entries(value as Record<string, T>)
        .map(([site, v]) => ({ site, value: v }))
        .sort((a, b) => a.site.localeCompare(b.site));
}

// The map once a site's value changes. A site the map lacks is left out: the bars add sites, the list never does.
export function withSiteValue<T>(map: Record<string, T>, site: string, value: T): Record<string, T> {
    if (map == null || !(site in map)) {
        return map ?? null;
    }
    return { ...map, [site]: value };
}

// The map without the site; null once empty, so settings.json loses the key, as when the line is deleted.
export function withoutSite<T>(map: Record<string, T>, site: string): Record<string, T> {
    if (map == null) {
        return null;
    }
    const next = { ...map };
    delete next[site];
    return Object.keys(next).length > 0 ? next : null;
}

// The kinds a site has an answer for, in the bar's order.
export function siteKinds(decisions: Record<string, string>): string[] {
    return SitePermissionKinds.filter((k) => typeof decisions?.[k] === "string" && decisions[k] !== "");
}

// One kind's answer changed, or removed with null; a site without an answer left is removed.
export function withSiteKind(
    store: SitePermissionStore,
    site: string,
    kind: string,
    decision: string
): SitePermissionStore {
    if (store == null || store[site] == null) {
        return store ?? null;
    }
    const decisions = { ...store[site] };
    if (decision === DecisionAllow || decision === DecisionBlock) {
        decisions[kind] = decision;
    } else {
        delete decisions[kind];
    }
    if (Object.keys(decisions).length === 0) {
        return withoutSite(store, site);
    }
    return { ...store, [site]: decisions };
}
