// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What pages of the browser panel may use (#663). Electron grants every permission a page asks for unless main says
// otherwise, and the panel holds the user's sign-ins while agents drive it, so emain/moltenterm-site-permissions.ts
// applies this rule to every page outside MoltenTerm's own interface: fullscreen and writing to the clipboard pass;
// the camera, the microphone, the location and notifications ask the user once per site (a host with its port) and
// the answer is remembered in browser:sitepermissions; everything else (MIDI, HID, serial, USB, reading the
// clipboard, screen capture, pointer lock...) is denied. Pure: shared by emain and the panel's bar.

export const SitePermissionsKey = "browser:sitepermissions";

export const KindCamera = "camera";
export const KindMicrophone = "microphone";
export const KindLocation = "location";
export const KindNotifications = "notifications";
export const SitePermissionKinds = [KindCamera, KindMicrophone, KindLocation, KindNotifications];

export const DecisionAllow = "allow";
export const DecisionBlock = "block";
// Escape, a closed tab or no answer: refused this time, nothing remembered.
export const DecisionDismiss = "dismiss";

export const VerdictAllow = "allow";
export const VerdictDeny = "deny";
export const VerdictAsk = "ask";
// A page's request to launch an app: emain's external link rule decides (emain/moltenterm-external-links.ts).
export const VerdictExternal = "external";

export type SitePermissionStore = Record<string, Record<string, string>>;
export type PermissionVerdict = { verdict: string; kinds?: string[] };

// Granted without asking: a video going full screen, a page's copy button.
const AlwaysAllowed = ["fullscreen", "clipboard-sanitized-write"];

// The site a decision is remembered for: the page's host with its port, for web pages only.
export function permissionSite(url: string): string {
    try {
        const u = new URL(url);
        if ((u.protocol !== "http:" && u.protocol !== "https:") || u.hostname === "") {
            return null;
        }
        return u.host.toLowerCase();
    } catch {
        return null;
    }
}

function mediaKinds(mediaTypes: unknown): string[] {
    if (!Array.isArray(mediaTypes)) {
        return [];
    }
    const kinds: string[] = [];
    if (mediaTypes.includes("video")) {
        kinds.push(KindCamera);
    }
    if (mediaTypes.includes("audio")) {
        kinds.push(KindMicrophone);
    }
    return kinds;
}

// The rule for one request (Electron's permission request handler).
export function classifyPermissionRequest(permission: string, details?: { mediaTypes?: unknown }): PermissionVerdict {
    if (AlwaysAllowed.includes(permission)) {
        return { verdict: VerdictAllow };
    }
    switch (permission) {
        case "media": {
            const kinds = mediaKinds(details?.mediaTypes);
            return kinds.length === 0 ? { verdict: VerdictDeny } : { verdict: VerdictAsk, kinds };
        }
        case "geolocation":
            return { verdict: VerdictAsk, kinds: [KindLocation] };
        case "notifications":
            return { verdict: VerdictAsk, kinds: [KindNotifications] };
        case "openExternal":
            return { verdict: VerdictExternal };
        default:
            return { verdict: VerdictDeny };
    }
}

function decisionOf(store: SitePermissionStore, site: string, kind: string): string {
    const value = store?.[site]?.[kind];
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// What the remembered decisions say about a request: allow when every kind is allowed, deny when one is blocked,
// otherwise the kinds still to ask about.
export function rememberedVerdict(store: SitePermissionStore, site: string, kinds: string[]): PermissionVerdict {
    if (site == null || kinds.length === 0) {
        return { verdict: VerdictDeny };
    }
    const undecided: string[] = [];
    for (const kind of kinds) {
        const decision = decisionOf(store, site, kind);
        if (decision === DecisionBlock) {
            return { verdict: VerdictDeny };
        }
        if (decision !== DecisionAllow) {
            undecided.push(kind);
        }
    }
    return undecided.length === 0 ? { verdict: VerdictAllow } : { verdict: VerdictAsk, kinds: undecided };
}

// The rule for a check (Electron's permission check handler, synchronous): only what was granted for good passes.
export function checkPermission(
    store: SitePermissionStore,
    permission: string,
    origin: string,
    mediaType?: string
): boolean {
    if (AlwaysAllowed.includes(permission)) {
        return true;
    }
    let kind: string = null;
    if (permission === "media") {
        kind = mediaType === "video" ? KindCamera : mediaType === "audio" ? KindMicrophone : null;
    } else if (permission === "geolocation") {
        kind = KindLocation;
    } else if (permission === "notifications") {
        kind = KindNotifications;
    }
    if (kind == null) {
        return false;
    }
    const site = permissionSite(origin);
    return site != null && decisionOf(store, site, kind) === DecisionAllow;
}

// The store after the user's answer; a dismissal changes nothing.
export function withDecision(
    store: SitePermissionStore,
    site: string,
    kinds: string[],
    decision: string
): SitePermissionStore {
    if (site == null || (decision !== DecisionAllow && decision !== DecisionBlock)) {
        return store ?? {};
    }
    const current = store?.[site] ?? {};
    const next = { ...current };
    for (const kind of kinds) {
        if (SitePermissionKinds.includes(kind)) {
            next[kind] = decision;
        }
    }
    return { ...(store ?? {}), [site]: next };
}

// Only these answers come back from the bar.
export function validDecision(decision: unknown): string {
    return decision === DecisionAllow || decision === DecisionBlock ? decision : DecisionDismiss;
}

const WhatKeys: Record<string, string> = {
    [KindCamera]: "browser.sitePermission.what.camera",
    [KindMicrophone]: "browser.sitePermission.what.microphone",
    [KindLocation]: "browser.sitePermission.what.location",
    [KindNotifications]: "browser.sitePermission.what.notifications",
};

// The i18n key of what a request asks for, as the bar words it.
export function sitePermissionWhatKey(kinds: string[]): string {
    const set = new Set(kinds ?? []);
    if (set.has(KindCamera) && set.has(KindMicrophone)) {
        return "browser.sitePermission.what.cameraMicrophone";
    }
    for (const kind of SitePermissionKinds) {
        if (set.has(kind)) {
            return WhatKeys[kind];
        }
    }
    return "browser.sitePermission.what.camera";
}
