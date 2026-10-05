// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Sign-in popups in the in-app engine (FR-BRW-003, DS-BRW-003). Pure functions shared by emain
// (emain/moltenterm-popups.ts, which owns the popup windows) and the browser panel (the refusal bar): no Electron and
// no store import here.

// What a page's window.open or target=_blank becomes:
//   popup: a real child window with window.opener intact (sign-in flows post their result back through it);
//   tab:   a new tab of the browser panel (#140), as before;
//   deny:  nothing (script URLs).
export const WindowOpenPopup = "popup";
export const WindowOpenTab = "tab";
export const WindowOpenDeny = "deny";

export type WindowOpenKind = typeof WindowOpenPopup | typeof WindowOpenTab | typeof WindowOpenDeny;

// The fields of Electron's HandlerDetails the decision reads.
export type WindowOpenDetails = { url?: string; features?: string; disposition?: string };

export const PopupDefaultWidth = 500;
export const PopupDefaultHeight = 650;
export const PopupMinSize = 240;
export const PopupMaxSize = 4000;

export type PopupBounds = { width: number; height: number; x?: number; y?: number };

// window.features as a map: "width=480,height=600,popup" -> { width: "480", height: "600", popup: "" }.
export function parseWindowFeatures(features: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (features ?? "").split(/[,\s]+/)) {
        if (part === "") {
            continue;
        }
        const eq = part.indexOf("=");
        const key = (eq < 0 ? part : part.slice(0, eq)).trim().toLowerCase();
        if (key === "") {
            continue;
        }
        out[key] =
            eq < 0
                ? ""
                : part
                      .slice(eq + 1)
                      .trim()
                      .toLowerCase();
    }
    return out;
}

// HTML's rule for boolean window features: present without a value, "yes", or a non-zero number.
function featureOn(value: string): boolean {
    if (value == null) {
        return false;
    }
    if (value === "" || value === "yes" || value === "true") {
        return true;
    }
    const n = parseInt(value, 10);
    return !isNaN(n) && n !== 0;
}

export function classifyWindowOpen(details: WindowOpenDetails): WindowOpenKind {
    const url = (details?.url ?? "").trim();
    const lower = url.toLowerCase();
    if (lower.startsWith("javascript:")) {
        return WindowOpenDeny;
    }
    const features = parseWindowFeatures(details?.features);
    // A page that gives up its opener does not need a window of its own.
    if (featureOn(features.noopener) || featureOn(features.noreferrer)) {
        return WindowOpenTab;
    }
    // An empty window is filled by its opener (window.open("", name) then w.location = ...): it must exist.
    if (url === "" || lower === "about:blank") {
        return WindowOpenPopup;
    }
    if (!lower.startsWith("http:") && !lower.startsWith("https:")) {
        return WindowOpenTab;
    }
    if ("popup" in features) {
        return featureOn(features.popup) ? WindowOpenPopup : WindowOpenTab;
    }
    if (details?.disposition === "new-window") {
        return WindowOpenPopup;
    }
    return WindowOpenTab;
}

function clampSize(value: string, fallback: number): number {
    const n = parseInt(value ?? "", 10);
    if (isNaN(n) || n <= 0) {
        return fallback;
    }
    return Math.min(PopupMaxSize, Math.max(PopupMinSize, n));
}

function position(value: string): number {
    const n = parseInt(value ?? "", 10);
    return isNaN(n) ? undefined : n;
}

// The popup's size from the page's features; x/y only when the page placed it (otherwise the caller centres it).
export function popupBounds(features: string): PopupBounds {
    const f = parseWindowFeatures(features);
    const bounds: PopupBounds = {
        width: clampSize(f.width ?? f.innerwidth, PopupDefaultWidth),
        height: clampSize(f.height ?? f.innerheight, PopupDefaultHeight),
    };
    const x = position(f.left ?? f.screenx);
    const y = position(f.top ?? f.screeny);
    if (x != null && y != null) {
        bounds.x = x;
        bounds.y = y;
    }
    return bounds;
}

export function centerIn(
    size: { width: number; height: number },
    parent: { x: number; y: number; width: number; height: number }
): { x: number; y: number } {
    return {
        x: Math.round(parent.x + (parent.width - size.width) / 2),
        y: Math.round(parent.y + (parent.height - size.height) / 2),
    };
}

// The popup's title: its site first, so the user always sees which domain asks for a password.
export function popupTitle(url: string, pageTitle: string): string {
    let host = "";
    try {
        host = new URL(url).host;
    } catch {
        host = "";
    }
    const title = (pageTitle ?? "").trim();
    if (host === "") {
        return title;
    }
    if (title === "" || title === host) {
        return host;
    }
    return `${host} — ${title}`;
}

// --- Refusals -----------------------------------------------------------------------------------------------------

// A provider that refuses embedded browsers, and how its refusal page is recognised. Only Google is known today;
// others are added here when observed.
type RefusalProvider = {
    id: string;
    label: string;
    hosts: string[];
    refused: (u: URL) => boolean;
};

const GoogleRejectedPaths = new Set(["/v3/signin/rejected", "/signin/rejected"]);

const RefusalProviders: RefusalProvider[] = [
    {
        id: "google",
        label: "Google",
        hosts: ["accounts.google.com"],
        refused: (u) => {
            const path = u.pathname.replace(/\/+$/, "");
            if (GoogleRejectedPaths.has(path)) {
                return true;
            }
            if (path !== "/signin/oauth/error" && path !== "/v3/signin/oauth/error") {
                return false;
            }
            return oauthErrorReason(u) === "disallowed_useragent";
        },
    },
];

// Google's OAuth error page carries the reason in authError, base64 of a small protobuf whose text includes it.
function oauthErrorReason(u: URL): string {
    const direct = u.searchParams.get("error") ?? "";
    if (direct.toLowerCase() === "disallowed_useragent") {
        return "disallowed_useragent";
    }
    const raw = u.searchParams.get("authError");
    if (!raw) {
        return null;
    }
    const decoded = decodeBase64Loose(raw);
    return decoded != null && decoded.includes("disallowed_useragent") ? "disallowed_useragent" : null;
}

// Base64 or base64url, padding optional; the bytes are read as Latin-1, enough to find an ASCII reason inside.
function decodeBase64Loose(value: string): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const clean = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    let bits = 0;
    let acc = 0;
    let out = "";
    for (const ch of clean) {
        const v = alphabet.indexOf(ch);
        if (v < 0) {
            return null;
        }
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out += String.fromCharCode((acc >> bits) & 0xff);
        }
    }
    return out;
}

export type SignInRefusal = { provider: string; label: string };

function parseWebUrl(url: string): URL {
    try {
        const u = new URL(url);
        return u.protocol === "https:" || u.protocol === "http:" ? u : null;
    } catch {
        return null;
    }
}

function providerOf(u: URL): RefusalProvider {
    const host = u.hostname.toLowerCase();
    return RefusalProviders.find((p) => p.hosts.includes(host)) ?? null;
}

export function detectSignInRefusal(url: string): SignInRefusal {
    const u = parseWebUrl(url);
    if (u == null) {
        return null;
    }
    const provider = providerOf(u);
    if (provider == null || !provider.refused(u)) {
        return null;
    }
    return { provider: provider.id, label: provider.label };
}

// Whether the page belongs to a sign-in provider (never the page to come back to).
export function isSignInProviderUrl(url: string): boolean {
    const u = parseWebUrl(url);
    return u != null && providerOf(u) != null;
}

// The refusal bar of one panel tab. returnUrl is the page the user was on before the provider's: the one the
// installed browser continues from.
export type SignInBar = SignInRefusal & { returnUrl: string; host: string };

export type SignInTabState = { lastSiteUrl?: string; bar?: SignInBar };

function hostOf(url: string): string {
    return parseWebUrl(url)?.host.toLowerCase() ?? "";
}

// A main-frame navigation of the tab: a refusal shows the bar; the bar goes away once the tab reaches another site.
export function signInOnNavigate(prev: SignInTabState, url: string): SignInTabState {
    const state = prev ?? {};
    const refusal = detectSignInRefusal(url);
    if (refusal != null) {
        return { ...state, bar: { ...refusal, returnUrl: state.lastSiteUrl || url, host: hostOf(url) } };
    }
    if (isSignInProviderUrl(url) || parseWebUrl(url) == null) {
        return state;
    }
    const next: SignInTabState = { ...state, lastSiteUrl: url };
    if (next.bar != null && hostOf(url) !== next.bar.host) {
        delete next.bar;
    }
    return next;
}

// A popup opened by the tab hit a refusal: the popup is gone, the tab's own page is the one to continue from.
export function signInOnPopupRefused(prev: SignInTabState, refusal: SignInRefusal, tabUrl: string): SignInTabState {
    const state = prev ?? {};
    const returnUrl = isSignInProviderUrl(tabUrl) ? state.lastSiteUrl || tabUrl : tabUrl;
    return { ...state, bar: { ...refusal, returnUrl, host: hostOf(tabUrl) } };
}

export function signInDismiss(prev: SignInTabState): SignInTabState {
    if (prev?.bar == null) {
        return prev;
    }
    const next = { ...prev };
    delete next.bar;
    return next;
}
